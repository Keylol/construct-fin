# Ferrum deployment layout

Target server assumptions:

1. Ubuntu 24.04
2. `construct` Linux user exists
3. Project directory: `/srv/construct/app`
4. PostgreSQL runs locally on the same VPS
5. Mini App served by nginx from static `miniapp_web/dist`
6. Only two app services stay in `systemd`:
   - `construct-miniapp-api`
   - `construct-bot`

## Files in this folder

1. `env.production.example`
   Production `.env` template for the server.
2. `systemd/construct-miniapp-api.service`
   Linux service for Mini App API.
3. `systemd/construct-bot.service`
   Linux service for the Telegram bot.
4. `nginx/app.pckonstruct.com.conf`
   nginx site config for Mini App static frontend + API proxy.

## Planned runtime

1. Frontend:
   nginx serves `/srv/construct/app/miniapp_web/dist`
2. API:
   `127.0.0.1:8080`
3. Bot:
   long polling, same `.env`
4. PostgreSQL:
   local `127.0.0.1:5432`

## Notes

1. Tunnels are not used in Ferrum production.
2. `MINIAPP_URL` must point to the final HTTPS domain.
3. Telegram menu button should be updated only after domain + TLS are live.
