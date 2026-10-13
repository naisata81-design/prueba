# Servidor de Render — v2 (multi-cliente + MongoDB Atlas)

## Variables de entorno (Render → Environment)
| Variable | Qué es |
|---|---|
| `MONGODB_URI` | Cadena de MongoDB Atlas. **Solo aquí**, nunca en el código |
| `JWT_SECRET` | Firma las sesiones de los clientes (Render la genera) |
| `ADMIN_TOKEN` | Contraseña de `admin.html` (Render la genera) |
| `DEVICE_KEY` | **La misma que ya está grabada en tus ESP-01** |
| `ALLOWED_ORIGIN` | `https://tu-usuario.github.io` |
| `APP_TIMEZONE`, `POLL_SECONDS` | Igual que antes |

En Atlas: *Network Access* debe permitir la salida de Render (`0.0.0.0/0` si no tienes IP fija).

## Cómo se vinculan los equipos (por número de serie)
Cada ESP trae grabado su **número de serie** (`DEVICE_ID`, único por equipo, ej. `DAL-V5-000123`) y su modelo (`DAL-RELAY-V5`).
Al encenderse y conectarse, el equipo se registra solo en el servidor, **sin dueño** (no recibe órdenes).
El cliente entra a *Dispositivos → Alta*, escribe el número de serie y el equipo queda vinculado a su cuenta.
Si ya está vinculado a otra cuenta, el servidor no deja agregarlo. Para liberarlo: el dueño lo quita de su cuenta, o tú desde el admin.
Un número de serie que nunca se ha conectado no se puede vincular. Equipos viejos: `POST /api/admin/devices/:id/assign` con `{ "accountId": "CLI-..." }`.

## ESP-01
Sin cambios: `POST /api/devices/:id/status` con `x-device-key`, misma respuesta (`desired`, `pollSeconds`, Wi-Fi remoto).

## API (cliente: `Authorization: Bearer <token de login>`)
- `POST /api/auth/register` `{company,email,password≥8}` · `POST /api/auth/login` → `{token, account}`
- `GET /api/state` → cuenta, sucursales, zonas, dispositivos, rutinas y equipos detectados
- `PATCH /api/me` `{company,color,logo}`
- `POST /api/branches` · `PATCH|DELETE /api/branches/:id` · `POST /api/branches/:id/zones` · `DELETE /api/branches/:id/zones/:zid`
- `POST /api/devices` `{id,name,model,branchId,zoneId}` · `PATCH|DELETE /api/devices/:id` · `POST /api/devices/:id/command` · `POST|DELETE /api/devices/:id/wifi`
- `POST /api/routines` · `PUT|PATCH|DELETE /api/routines/:id` — `{branchId, zoneId|null, onTime, offTime, days[0-6], enabled}`
- Admin (`ADMIN_TOKEN`): `GET /api/admin/accounts`, `DELETE /api/admin/accounts/:id`, `GET /api/admin/devices`, `POST /api/admin/devices/:id/assign`, `PATCH|DELETE /api/admin/devices/:id` (nota interna / borrar registro), `POST /api/admin/devices/:id/release`, `GET|POST /api/admin/models`, `PATCH|DELETE /api/admin/models/:id` (catálogo de modelos)

## Cambios respecto a v1
- Se quitó `storage.js` (Upstash/archivo): ahora todo vive en MongoDB.
- Ya no existen las rutas viejas del panel con `ADMIN_TOKEN` (`GET /api/devices`, `/schedule`): el panel nuevo usa `/api/state` y `/api/routines`.
- Las rutinas se evalúan en el servidor cada minuto, por sucursal o zona, con una sola zona horaria (`APP_TIMEZONE`).

## Firmware DAL-RELAY-V5 (horarios en el equipo)
En cada respuesta de `POST /api/devices/:id/status` el servidor agrega `localDay`, `localSecs` (hora local de `APP_TIMEZONE`) y `sched`
(`"enc,apa,dias;..."`, minutos desde 00:00, `dias` = máscara bit0=domingo; máx. 12). El ESP los guarda en su flash y los ejecuta sin internet.
Si el ESP cambió el aire por su horario estando desconectado, avisa con `local:true` + `localAgo` y el servidor respeta ese estado
salvo que el panel haya mandado una orden más reciente. El ESP también informa `model`, `serial` y `fw` (se ven en el panel, sección Dispositivos).
