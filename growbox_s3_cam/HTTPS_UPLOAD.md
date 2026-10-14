# HTTPS camera upload

Copy `wifi_config.example.h` to `wifi_config.h`, configure Wi-Fi/MQTT, and set
`IMAGE_UPLOAD_TOKEN` to the same dedicated random secret as `server/.env`.
Use at least 32 characters. Never commit wifi_config.h or share the token in logs.

Photos use a binary `image/jpeg` POST to `IMAGE_UPLOAD_URL`, with the token in
`X-Upload-Token`. HTTPS and CA verification are mandatory. Redirects are disabled.
MQTT still carries sensor/status telemetry, relay commands and capture triggers.
Uploads run in one background task, use chunks of at most 4096 bytes, and are
limited to 1 MiB. On failure the next scheduled capture retries; photos are never
sent over MQTT as fallback. A valid NTP clock is required for TLS.

The server stores JPEGs and receipt-time sensor sidecars in the existing archive,
records camera_capture in InfluxDB, and notifies the dashboard via
growbox/camera/updated. Reload the Mosquitto ACL and nginx configuration on upgrade.
Build with the board/flash/OPI-PSRAM configuration from hzad_s3_cam_diag/README.md.

Verification after flashing: look for `[CAMERA HTTPS] HTTP 201` and check that
MQTT remains connected during uploads. Check the actual board for thermal, power,
and relay safety separately; upload tests do not verify those.
