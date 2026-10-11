'use strict';

/**
 * ============================================================
 *  storage.js — Dónde se guardan dispositivos y rutinas
 * ============================================================
 *  Dos modos, se elige solo según las variables de entorno:
 *
 *  1) Upstash Redis (RECOMENDADO en Render gratis)
 *     Define UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.
 *     Los datos sobreviven a reinicios y redeploys.
 *
 *  2) Archivo local data.json (por defecto)
 *     Sirve para pruebas en tu PC. En Render gratis el disco es
 *     EFÍMERO: el archivo se borra al reiniciar o redesplegar.
 *
 *  El estado completo (lista de equipos + rutinas) se guarda como
 *  un único JSON. Solo se escribe cuando cambia algo de configuración
 *  (nombre, rutinas, orden ON/OFF), no en cada consulta del ESP-01.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = 'ac-control:state';

const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

// Ejecuta un comando de Redis por la API REST de Upstash (requiere Node 18+).
async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash respondió HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Upstash: ${data.error}`);
  return data.result;
}

/** Devuelve el estado guardado, o null si todavía no hay nada. */
async function load() {
  if (useRedis) {
    const raw = await redis(['GET', REDIS_KEY]);
    return raw ? JSON.parse(raw) : null;
  }
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Guarda el estado completo. */
async function save(state) {
  const json = JSON.stringify(state);
  if (useRedis) {
    await redis(['SET', REDIS_KEY, json]);
    return;
  }
  // Escritura atómica: primero a un temporal y luego se renombra.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, FILE);
}

module.exports = {
  load,
  save,
  mode: useRedis ? 'Upstash Redis' : 'archivo local',
  isEphemeralRisk: !useRedis && Boolean(process.env.RENDER),
};
