'use strict';

/**
 * ============================================================
 *  CONTROL DE AIRES — BACKEND (Node.js + Express)
 * ============================================================
 *  Pensado para desplegarse gratis en Render.com.
 *
 *  Quién habla con quién:
 *    - El ESP-01 llama a   POST /api/devices/:id/status   (clave DEVICE_KEY)
 *    - La página web llama a  GET /api/devices, .../command, .../schedule ...
 *      (token ADMIN_TOKEN en la cabecera Authorization: Bearer ...)
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │  DÓNDE CONFIGURAR LAS CREDENCIALES                       │
 *  │  Nada se escribe en el código: son VARIABLES DE ENTORNO  │
 *  │  (Render → tu servicio → Environment):                   │
 *  │    ADMIN_TOKEN     contraseña de la página web           │
 *  │    DEVICE_KEY      clave que usan los ESP-01             │
 *  │    ALLOWED_ORIGIN  https://TU-USUARIO.github.io          │
 *  │    APP_TIMEZONE    zona horaria de las rutinas           │
 *  │    POLL_SECONDS    cada cuánto consulta el ESP-01        │
 *  │    UPSTASH_REDIS_REST_URL / _TOKEN   (opcional, ver      │
 *  │                    storage.js: guarda datos permanentes) │
 *  └──────────────────────────────────────────────────────────┘
 *
 *  Estados: "ON" = aire encendido, "OFF" = aire apagado.
 *  Días de la semana: 0 = domingo, 1 = lunes ... 6 = sábado.
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const crypto = require('crypto');
const storage = require('./storage');

/* ------------------------------------------------------------
 *  CONFIGURACIÓN (variables de entorno)
 * ---------------------------------------------------------- */
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cambia-este-token';
const DEVICE_KEY = process.env.DEVICE_KEY || 'cambia-esta-clave';
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Mexico_City';
const POLL_SECONDS = clamp(Number(process.env.POLL_SECONDS) || 10, 3, 120);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_ROUTINES = 20;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ------------------------------------------------------------
 *  MODELO EN MEMORIA
 *  Device = {
 *    id, name,
 *    desiredState: 'ON'|'OFF'   lo que se le ordena al equipo
 *    reportedState: 'ON'|'OFF'  lo que el equipo dijo tener
 *    lastSeen: ISO|null, rssi, fw,
 *    routines: [{ id, onTime:'HH:MM'|null, offTime:'HH:MM'|null,
 *                 days:[0..6], enabled:boolean }]
 *  }
 * ---------------------------------------------------------- */
const devices = new Map();

function newDevice(id, state) {
  return {
    id,
    name: id,
    desiredState: state, // al registrarse, se adopta el estado real del equipo
    reportedState: state,
    lastSeen: null,
    rssi: null,
    fw: null,
    ssid: null, // red Wi-Fi a la que está conectado el equipo
    wifiStatus: null, // { state, ssid, at } del último cambio de red pedido
    pendingWifi: null, // { ssid, password } SOLO en memoria, hasta que el equipo lo recoge
    routines: [],
  };
}

function isOnline(d) {
  if (!d.lastSeen) return false;
  const windowMs = Math.max(30, POLL_SECONDS * 3) * 1000;
  return Date.now() - Date.parse(d.lastSeen) < windowMs;
}

function toPublic(d) {
  return {
    id: d.id,
    name: d.name,
    desiredState: d.desiredState,
    reportedState: d.reportedState,
    online: isOnline(d),
    lastSeen: d.lastSeen,
    rssi: d.rssi,
    fw: d.fw,
    ssid: d.ssid,
    wifiStatus: d.wifiStatus, // nunca incluye la contraseña
    routines: d.routines,
  };
}

/* ------------------------------------------------------------
 *  PERSISTENCIA (con pequeño retraso para agrupar cambios)
 * ---------------------------------------------------------- */
let saveTimer = null;

function snapshot() {
  // La contraseña de una red pendiente vive solo en memoria: nunca se guarda en disco ni en Redis.
  return { version: 1, devices: Array.from(devices.values(), ({ pendingWifi, ...rest }) => rest) };
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    storage.save(snapshot()).catch((err) => console.error('[storage] Error al guardar:', err.message));
  }, 300);
}

/* ------------------------------------------------------------
 *  UTILIDADES HTTP
 * ---------------------------------------------------------- */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({ error: 'Token de administrador incorrecto' });
  next();
}

function requireDevice(req, res, next) {
  if (!safeEqual(req.get('x-device-key') || '', DEVICE_KEY)) {
    return res.status(401).json({ error: 'Clave de dispositivo incorrecta' });
  }
  next();
}

function mustGetDevice(id) {
  const d = devices.get(id);
  if (!d) throw new HttpError(404, 'No existe un equipo con ese ID');
  return d;
}

/* ------------------------------------------------------------
 *  CAMBIO DE RED WI-FI
 *  wifiStatus.state: 'pending'   esperando que el equipo consulte
 *                    'sent'      el equipo la recibió y la está probando
 *                    'ok' | 'failed' | 'cancelled'
 *  La contraseña nueva (d.pendingWifi) solo vive en memoria.
 * ---------------------------------------------------------- */
function wifiInProgress(d) {
  return Boolean(d.wifiStatus) && (d.wifiStatus.state === 'pending' || d.wifiStatus.state === 'sent');
}

/** El equipo informa el resultado ("ok" / "failed"). Devuelve true si cambió algo. */
function applyWifiResult(d, result) {
  if ((result !== 'ok' && result !== 'failed') || !wifiInProgress(d)) return false;
  d.wifiStatus = { ...d.wifiStatus, state: result, at: new Date().toISOString() };
  d.pendingWifi = null;
  return true;
}

function parseState(value) {
  const s = String(value || '').toUpperCase();
  if (s !== 'ON' && s !== 'OFF') throw new HttpError(400, 'El estado debe ser "ON" u "OFF"');
  return s;
}

/* ------------------------------------------------------------
 *  VALIDACIÓN DE RUTINAS
 * ---------------------------------------------------------- */
function cleanTime(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new HttpError(400, `${label}: la hora debe tener formato HH:MM (24 h)`);
  }
  return value;
}

function normalizeRoutines(input) {
  if (!Array.isArray(input)) throw new HttpError(400, '"routines" debe ser una lista');
  if (input.length > MAX_ROUTINES) throw new HttpError(400, `Máximo ${MAX_ROUTINES} rutinas por equipo`);

  return input.map((r, i) => {
    const label = `Rutina ${i + 1}`;
    const item = r || {};
    const onTime = cleanTime(item.onTime, label);
    const offTime = cleanTime(item.offTime, label);
    if (!onTime && !offTime) throw new HttpError(400, `${label}: define al menos una hora (encendido o apagado)`);
    if (onTime && offTime && onTime === offTime) {
      throw new HttpError(400, `${label}: la hora de encendido y apagado no pueden ser iguales`);
    }

    const days = [...new Set((Array.isArray(item.days) ? item.days : []).map(Number))];
    if (!days.length || days.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
      throw new HttpError(400, `${label}: elige al menos un día (0 = domingo ... 6 = sábado)`);
    }
    days.sort((a, b) => a - b);

    return {
      id: typeof item.id === 'string' && item.id.length <= 40 ? item.id : crypto.randomUUID(),
      onTime,
      offTime,
      days,
      enabled: item.enabled !== false,
    };
  });
}

/* ------------------------------------------------------------
 *  APP EXPRESS
 * ---------------------------------------------------------- */
const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '20kb' }));

// Para comprobar que el servicio vive (Render lo usa como health check).
app.get('/', (req, res) => res.json({ ok: true, service: 'ac-control-api' }));
app.get('/health', (req, res) => res.type('text').send('ok'));

/** GET /api/devices — lista todos los aires con estado y rutinas. */
app.get('/api/devices', requireAdmin, (req, res) => {
  const list = Array.from(devices.values())
    .map(toPublic)
    .sort((a, b) => a.id.localeCompare(b.id));
  res.json({
    serverTime: new Date().toISOString(),
    timezone: APP_TIMEZONE,
    pollSeconds: POLL_SECONDS,
    devices: list,
  });
});

/**
 * POST /api/devices/:id/status — lo llama el ESP-01.
 * Body: { "state": "ON"|"OFF", "rssi": -60, "fw": "1.0.0" }
 * Responde con el estado que debe tener el relé.
 * Si el ID no existe, el equipo se registra solo la primera vez.
 */
app.post('/api/devices/:id/status', requireDevice, (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) throw new HttpError(400, 'ID inválido (usa letras, números, - o _; máx. 40)');
  const body = req.body || {};
  const reported = parseState(body.state);

  let d = devices.get(id);
  const isNew = !d;
  if (isNew) {
    d = newDevice(id, reported);
    devices.set(id, d);
    console.log(`[devices] Equipo nuevo registrado: ${id} (estado ${reported})`);
  }

  d.reportedState = reported;
  d.lastSeen = new Date().toISOString();
  if (Number.isFinite(body.rssi)) d.rssi = body.rssi;
  if (typeof body.fw === 'string') d.fw = body.fw.slice(0, 20);

  let changed = isNew;

  // Red a la que está conectado (llega en hexadecimal para evitar problemas con comillas y acentos).
  if (typeof body.ssidHex === 'string' && /^([0-9a-f]{2}){0,32}$/i.test(body.ssidHex)) {
    const ssid = Buffer.from(body.ssidHex, 'hex').toString('utf8');
    if (ssid !== d.ssid) {
      d.ssid = ssid;
      changed = true;
    }
  }
  if (applyWifiResult(d, body.wifiResult)) changed = true;

  const reply = { desired: d.desiredState, pollSeconds: POLL_SECONDS, serverTime: new Date().toISOString() };

  // Si hay una red nueva pendiente, se le entrega al equipo (en hexadecimal).
  if (d.pendingWifi) {
    reply.wifiSsidHex = Buffer.from(d.pendingWifi.ssid, 'utf8').toString('hex');
    reply.wifiPassHex = Buffer.from(d.pendingWifi.password, 'utf8').toString('hex');
    if (d.wifiStatus && d.wifiStatus.state === 'pending') {
      d.wifiStatus = { ...d.wifiStatus, state: 'sent', at: new Date().toISOString() };
      changed = true;
    }
  }

  if (changed) persist();
  res.json(reply);
});

/** POST /api/devices/:id/command — botón manual de la web. Body: { "state": "ON"|"OFF" } */
app.post('/api/devices/:id/command', requireAdmin, (req, res) => {
  const d = mustGetDevice(req.params.id);
  d.desiredState = parseState((req.body || {}).state);
  persist();
  res.json(toPublic(d));
});

/**
 * POST /api/devices/:id/schedule — guarda las rutinas (reemplaza la lista completa).
 * Body: { "routines": [ { "onTime":"08:00", "offTime":"18:00", "days":[1,2,3,4,5], "enabled":true } ] }
 */
app.post('/api/devices/:id/schedule', requireAdmin, (req, res) => {
  const d = mustGetDevice(req.params.id);
  d.routines = normalizeRoutines((req.body || {}).routines);
  persist();
  res.json(toPublic(d));
});

/** PATCH /api/devices/:id — cambia el nombre. Body: { "name": "Aire Recepción" } */
app.patch('/api/devices/:id', requireAdmin, (req, res) => {
  const d = mustGetDevice(req.params.id);
  const name = String((req.body || {}).name ?? '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'El nombre debe tener entre 1 y 60 caracteres');
  d.name = name;
  persist();
  res.json(toPublic(d));
});

/**
 * POST /api/devices/:id/wifi — pide al equipo que cambie de red Wi-Fi.
 * Body: { "ssid": "MiRed", "password": "clave" }  (password vacío = red abierta)
 * El equipo prueba la red nueva; si no conecta o no llega al servidor, vuelve a la anterior.
 */
app.post('/api/devices/:id/wifi', requireAdmin, (req, res) => {
  const d = mustGetDevice(req.params.id);
  const body = req.body || {};
  const ssid = typeof body.ssid === 'string' ? body.ssid : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const ssidBytes = Buffer.byteLength(ssid, 'utf8');
  const passBytes = Buffer.byteLength(password, 'utf8');

  if (ssidBytes < 1 || ssidBytes > 32) throw new HttpError(400, 'El nombre de la red debe tener entre 1 y 32 caracteres');
  if (passBytes !== 0 && (passBytes < 8 || passBytes > 63)) {
    throw new HttpError(400, 'La contraseña debe tener entre 8 y 63 caracteres (déjala vacía solo si la red es abierta)');
  }
  if (wifiInProgress(d)) throw new HttpError(409, 'Ya hay un cambio de red en curso. Espera el resultado o cancélalo');

  d.pendingWifi = { ssid, password };
  d.wifiStatus = { state: 'pending', ssid, at: new Date().toISOString() };
  persist();
  res.json(toPublic(d));
});

/** DELETE /api/devices/:id/wifi — cancela un cambio de red que el equipo aún no terminó. */
app.delete('/api/devices/:id/wifi', requireAdmin, (req, res) => {
  const d = mustGetDevice(req.params.id);
  if (!wifiInProgress(d)) throw new HttpError(409, 'No hay un cambio de red en curso');
  d.pendingWifi = null;
  d.wifiStatus = { ...d.wifiStatus, state: 'cancelled', at: new Date().toISOString() };
  persist();
  res.json(toPublic(d));
});

/** DELETE /api/devices/:id — elimina un equipo (si sigue encendido, se registrará de nuevo). */
app.delete('/api/devices/:id', requireAdmin, (req, res) => {
  mustGetDevice(req.params.id);
  devices.delete(req.params.id);
  persist();
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Manejo central de errores (validaciones, JSON mal formado, etc.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

/* ------------------------------------------------------------
 *  PLANIFICADOR (node-cron)
 *  Cada minuto revisa las rutinas. Si la hora y el día coinciden,
 *  cambia el estado deseado; el ESP-01 lo aplica en su siguiente consulta.
 *  Un ON/OFF manual dura hasta que otra rutina lo cambie.
 *  Rutinas nocturnas (ej. enciende 22:00, apaga 06:00): el apagado
 *  cuenta como parte del día en que empezó la rutina.
 * ---------------------------------------------------------- */
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Día de la semana y hora "HH:MM" actuales en APP_TIMEZONE. */
function localNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { day: WEEKDAYS[get('weekday')], hhmm: `${get('hour')}:${get('minute')}` };
}

function evaluateSchedules(now = localNow()) {
  const prevDay = (now.day + 6) % 7;
  const changes = [];

  for (const d of devices.values()) {
    for (const r of d.routines) {
      if (!r.enabled) continue;
      const overnight = r.onTime && r.offTime && r.offTime < r.onTime;

      const fire = (state) => {
        if (d.desiredState !== state) {
          d.desiredState = state;
          changes.push({ id: d.id, state, routine: r.id });
        }
      };
      if (r.onTime === now.hhmm && r.days.includes(now.day)) fire('ON');
      if (r.offTime === now.hhmm && r.days.includes(overnight ? prevDay : now.day)) fire('OFF');
    }
  }

  if (changes.length) {
    persist();
    for (const c of changes) console.log(`[scheduler] ${now.hhmm} → ${c.id}: ${c.state}`);
  }
  return changes;
}

/* ------------------------------------------------------------
 *  ARRANQUE
 * ---------------------------------------------------------- */
async function main() {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: APP_TIMEZONE });
  } catch {
    console.error(`APP_TIMEZONE inválida: "${APP_TIMEZONE}". Ejemplo: America/Mexico_City`);
    process.exit(1);
  }

  if (ADMIN_TOKEN === 'cambia-este-token' || DEVICE_KEY === 'cambia-esta-clave') {
    console.warn('⚠️  Estás usando ADMIN_TOKEN / DEVICE_KEY por defecto. Defínelos como variables de entorno.');
  }
  if (storage.isEphemeralRisk) {
    console.warn('⚠️  Sin Upstash Redis: en Render los datos se pierden al reiniciar. Revisa storage.js.');
  }

  try {
    const saved = await storage.load();
    if (saved && Array.isArray(saved.devices)) {
      for (const d of saved.devices) {
        const dev = { ...newDevice(d.id, 'OFF'), ...d, pendingWifi: null };
        // La contraseña pendiente no se guarda: si el servidor se reinició a mitad de un cambio, queda cancelado.
        if (wifiInProgress(dev)) dev.wifiStatus = { ...dev.wifiStatus, state: 'cancelled', at: new Date().toISOString() };
        devices.set(dev.id, dev);
      }
    }
    console.log(`[storage] ${storage.mode}: ${devices.size} equipo(s) cargado(s)`);
  } catch (err) {
    // No seguimos: guardar un estado vacío encima de los datos reales sería peor.
    console.error('[storage] No se pudo cargar el estado:', err.message);
    process.exit(1);
  }

  cron.schedule('* * * * *', () => evaluateSchedules(), { timezone: APP_TIMEZONE });

  app.listen(PORT, () => console.log(`API lista en el puerto ${PORT} (zona horaria ${APP_TIMEZONE})`));

  // Render envía SIGTERM al reiniciar o redesplegar: guardamos antes de salir.
  process.on('SIGTERM', async () => {
    try {
      await storage.save(snapshot());
    } catch (err) {
      console.error('[storage] Error al guardar al cerrar:', err.message);
    }
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { app, devices, evaluateSchedules, localNow, normalizeRoutines };
