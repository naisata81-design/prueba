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

## Cómo se vinculan los equipos (sin tocar el ESP)
El `DEVICE_ID` que grabas en cada ESP debe **empezar con el ID de la cuenta del cliente**:
`CLI-0001AB-oficina1`. Así cada cliente solo ve y da de alta sus propios equipos.
Un equipo que llama antes del alta queda "detectado" y sin dueño: el servidor no le manda órdenes.
Equipos viejos sin prefijo: `POST /api/admin/devices/:id/assign` con `{ "accountId": "CLI-..." }`.

## ESP-01
Sin cambios: `POST /api/devices/:id/status` con `x-device-key`, misma respuesta (`desired`, `pollSeconds`, Wi-Fi remoto).

## API (cliente: `Authorization: Bearer <token de login>`)
- `POST /api/auth/register` `{company,email,password≥8}` · `POST /api/auth/login` → `{token, account}`
- `GET /api/state` → cuenta, sucursales, zonas, dispositivos, rutinas y equipos detectados
- `PATCH /api/me` `{company,color,logo}`
- `POST /api/branches` · `PATCH|DELETE /api/branches/:id` · `POST /api/branches/:id/zones` · `DELETE /api/branches/:id/zones/:zid`
- `POST /api/devices` `{id,name,model,branchId,zoneId}` · `PATCH|DELETE /api/devices/:id` · `POST /api/devices/:id/command` · `POST|DELETE /api/devices/:id/wifi`
- `POST /api/routines` · `PUT|PATCH|DELETE /api/routines/:id` — `{branchId, zoneId|null, onTime, offTime, days[0-6], enabled}`
- Admin (`ADMIN_TOKEN`): `GET /api/admin/accounts`, `DELETE /api/admin/accounts/:id`, `GET /api/admin/devices`, `POST /api/admin/devices/:id/assign`

## Cambios respecto a v1
- Se quitó `storage.js` (Upstash/archivo): ahora todo vive en MongoDB.
- Ya no existen las rutas viejas del panel con `ADMIN_TOKEN` (`GET /api/devices`, `/schedule`): el panel nuevo usa `/api/state` y `/api/routines`.
- Las rutinas se evalúan en el servidor cada minuto, por sucursal o zona, con una sola zona horaria (`APP_TIMEZONE`).
