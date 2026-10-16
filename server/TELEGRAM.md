# Telegram for HZAD / HTTPS camera uploads

The optional bot runs inside the bridge. Firmware changes are not needed if the
ESP already sends authenticated JPEG POSTs to /api/upload-image.

## Configuration

Set these in server/.env; never put real secrets in source control:

```dotenv
TELEGRAM_BOT_TOKEN=your_BotFather_token
TELEGRAM_CHAT_ID=123456789,987654321
TELEGRAM_AUTO_PHOTO=off
TELEGRAM_CAPTURE_TIMEOUT_MS=60000
```

Every authorised chat has control permissions, not just viewing access. Each
private-chat user must first start the bot. An empty token disables the bot; an
empty allowlist denies telemetry/control access. Network failures retry polling
after 30 seconds. Running a second polling process with the same token conflicts
with this one. Bot failures do not disable the bridge or HTTPS photo endpoint.

## Commands

- /status: readings and age, controller mode, relay state, alerts and timers.
- /photo: send the MQTT snapshot trigger, then wait for the next saved HTTPS
  frame (legacy MQTT frames also work). JPEG + sidecar must exist before sending.
  On timeout an explicitly labelled archived frame is returned, if available.
- /latest [n]: archive photos with their stored readings, not the live readings.
  Old HTTPS sidecars remain readable; missing fields/history are not invented.
- /autophoto off|on|30: disable forwarding, forward every received photo, or
  forward no more often than every 30 minutes. This does not change ESP capture
  scheduling. A requested /photo is not sent again as an automatic photo.
- /mode [id], /relay <1-6> <on|off>, /stats [hours], /notify on|off, /help.

REST and Telegram share the same manual relay guards. With BME disabled,
humidifier ON is refused because humidity is unavailable; manual heater ON also
requires the air-temperature channel. In incubation the heater is guarded by
substrate temperature. OFF is never blocked by sensor guards. These checks do
not prove physical relay actuation or replace hardware cutoffs.

## Upgrade without losing the active mode

Before recreating an older bridge, while it is still running, copy this migration
helper to the existing server directory and run:

```bash
cd /opt/esp32-greenhouse/server
bash state-preserve.sh --print
bash state-preserve.sh
docker compose up -d --no-deps --build bridge
```

The new Compose mount is ./bridge/state:/app/state. It loads that directory's
climate_state.json. Do not skip migration: a missing state starts the controller
in its default fruiting phase. If no state exists, choose an explicit mode with
the helper's --default-mode option. Preserve existing .env, image archive, and
IMAGE_UPLOAD_TOKEN. No MQTT/InfluxDB/nginx recreation is needed for this update.
Custom Compose overrides must be included consistently in migration/deployment.

## Verification

```bash
cd server/bridge
npm ci
npm test
```

Tests use a local fake Telegram API and MQTT stubs; child-process integration
tests use loopback endpoints. They never send messages to a real Telegram chat
or commands to physical relays. HTTPS transport/authentication/archive tests are
included, as are /photo delivery, auto forwarding, stored captions, relay guards,
signal shutdown, polling recovery and persistent-state checks.
