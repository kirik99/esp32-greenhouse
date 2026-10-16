# HZAD S3 HTTPS OTA — staged implementation

**Not deployed or hardware-qualified. Do not use the first release unattended.**
The existing ESP has no OTA receiver, so the first installation still requires
USB access. This branch builds on dashboard camera settings (PR #6).

## Safety boundaries

- Opt-in: `OTA_ENABLED` defaults false and no verification key is shipped.
- The receiver requires a rollback-enabled bootloader/core, a separate inactive
  OTA slot and valid time. Merely adding a CSV partition table is NOT enough.
- The inspected Arduino-ESP32 3.2.1 SDK has
  `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` for ESP32-S3. Other packages may differ.
  The dashboard reports the application's build flag and refuses OTA when it is
  off. This is NOT proof that an older bootloader already on the board has that
  flag: USB-install the matching rollback-enabled bootloader too. A sketch-level
  `#define` cannot enable rollback in a precompiled bootloader.
- No eFuses, Secure Boot or Flash Encryption settings are changed here. Manifest
  signatures are application-level verification, not hardware Secure Boot.
- Server dispatch requires PIN authentication, manual climate mode, six OFF
  relay states, fresh device telemetry (<30 seconds), broker connectivity and
  explicit supported/rollback flags. It never changes mode or switches relays.
- ESP independently requires all relay outputs OFF and no camera upload in
  progress. It refuses new relay ON commands/captures during OTA. Sensor/safety
  polling continues while download runs in a background task. This maintenance
  policy blocks emergency relay ON requests too; an operator must ensure that
  an all-OFF maintenance window is safe for the actual equipment.
- Firmware is downloaded over certificate-verified HTTPS without redirects,
  queries, userinfo or credentials in the URL. A dedicated `X-OTA-Token` header
  authenticates downloads, only at the compiled-in firmware base URL and exact
  SHA-256 filename. Exact Content-Length is required;
  chunked transfer is deliberately unsupported. Network operations have a 5s
  timeout and the read loop a 180s total deadline.
- RSA-2048 PKCS#1 v1.5 / SHA-256 signs target MAC-based ID, model, build number,
  size, hash, expiry and URL. The device streams into the inactive partition,
  checks the full SHA-256 and ESP image validation before switching boot slots.
- Only builds newer than `FIRMWARE_BUILD_NUMBER` are accepted. This is software
  version checking, not irreversible eFuse anti-rollback. Signed manifests expire
  within 24 hours; retained and fragmented MQTT commands are rejected. Commands
  are QoS0/non-retained; QoS0 offline queuing is disabled at the bridge.
- On first OTA boot, outputs remain OFF and camera is paused. After 60 seconds
  and a working MQTT connection the application is marked valid. After 180s
  without confirmation it restarts to let the bootloader roll back. This test
  verifies connectivity/control-loop survival, NOT sensor calibration or physical
  relay operation. A bad firmware can still require USB recovery.

Reference: [Espressif OTA and rollback](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/system/ota.html).

## First USB installation

1. Identify the actual board, flash size and current partition map. The supplied
   `growbox_s3_cam/partitions.csv` is ONLY for HZAD ESP32-S3 N16R8 (16 MiB flash,
   OPI PSRAM), with two 6 MiB application slots. Do not use it on an 8 MiB board.
   Changing partition layout is a USB migration; back up NVS/settings first.
2. Prepare and validate the matching rollback-enabled core/bootloader for that board. Do not
   upload a normal Arduino build and assume recovery has been enabled.
3. Generate an RSA-2048 signing key offline, e.g. `openssl genpkey -algorithm RSA
   -pkeyopt rsa_keygen_bits:2048 -out ota-private.pem`, then `openssl pkey -in
   ota-private.pem -pubout -out ota-public.pem`. Keep private key outside the repo,
   server, firmware and public artifact storage. Back it up securely.
4. In your ignored `wifi_config.h`, preserve the working Wi-Fi/MQTT/upload
   credentials, set `OTA_ENABLED true`, `FIRMWARE_BUILD_NUMBER 1`, and define
   `OTA_PUBLIC_KEY_PEM` as the PUBLIC key PEM string (with `\n` line breaks).
   Set `OTA_FIRMWARE_BASE_URL` to your HTTPS `/api/ota/firmware/` endpoint and a
   separate random 32+ character `OTA_DOWNLOAD_TOKEN` matching the server.
5. USB flash the initial image and matching rollback-enabled bootloader/partition
   table. Confirm the normal telemetry and `ota.enabled=true`, `ota.rollback=true`
   status before considering a remote update. Do not restore ON relay states.

## Server setup and subsequent release

Deploy bridge/dashboard changes and reload the MQTT ACL additions. The web MQTT
user remains read-only. `OTA_SIGNING_PUBLIC_KEY` must contain the same public PEM
as the ESP (quoted multiline value in Compose .env). Set `OTA_DOWNLOAD_TOKEN` to
the device's separate download secret. Missing key disables dispatch; missing or
short token disables downloads. Firmware is mounted read-only from
`server/bridge/firmware/`, excluded from Git and the Docker build context.
This server never signs releases and never accepts unsigned firmware uploads.

1. Build the next application with the exact device credentials, same OTA key,
   matching board/partition layout and a strictly increased integer
   `FIRMWARE_BUILD_NUMBER`. Preserve NVS compatibility between versions.
2. Compute the application `.bin` SHA-256 and copy it to
   `server/bridge/firmware/SHA256.bin`. The bridge provides token-authenticated
   downloads at `/api/ota/firmware/SHA256.bin` over the existing external HTTPS
   proxy. **The binary contains Wi-Fi/MQTT secrets. Do not publish it as a public
   GitHub Release or public CI artifact.** Use only the application image, never
   a merged USB-flash image, bootloader or partition table.
3. Create a short-lived signed manifest locally:

   ```text
   node tools/sign-ota.js app.bin /secure/ota-private.pem GrowboxESP32_84C7BB7ADFB4 https://growbox.weird.cyou/api/ota/firmware/SHA256.bin 2 EXPIRES_UNIX
   ```

   Save stdout as a JSON file. `EXPIRES_UNIX` is UTC Unix seconds, e.g. one hour
   ahead. The signer checks the application's embedded model/build marker.
4. Log into the dashboard with PIN. Manually choose a safe maintenance window,
   select manual mode and turn all outputs OFF. Choose the signed JSON file in
   "Обновление ESP по сети", inspect the target/build and explicitly confirm.
5. The REST endpoint returns 202 = REQUESTED, not installed. Follow device
   `downloading` / `verifying_image` / `rebooting` / `boot_verification` status and
   wait for the new build to become idle. An offline/old device is never success.
   Re-enable automatic climate control only after an operator validates it.

Endpoints: `GET /api/ota/status`, `POST /api/ota/start` with the manifest as JSON;
both require a PIN session Bearer token. No updates are triggered at startup,
from automatic CI, by choosing a file, or merely by receiving retained MQTT.

Do not overwrite the live hourly photo limit while deploying this branch:
that temporary server-only patch is separate from camera settings and this OTA
work. The production server is intentionally untouched by this implementation.

## Validation and remaining hardware acceptance

Run `npm test` in `server/bridge`. Tests cover signature tampering, expiry,
wrong target/model/size, authentication, stale/offline/unsupported device, manual
mode, active outputs and duplicate requests. CI compiles the HZAD S3 sketch with
dummy credentials; it does not publish a deployable binary or enable OTA.

Before enabling unattended use, hardware-test: successful upgrade, wrong hash,
wrong signing key, truncated download, Wi-Fi loss, power interruption while
writing inactive slot, corrupted image, failed MQTT after first boot and actual
rollback. Test all-OFF relay safety and ensure settings survive migration.
These hardware tests are NOT replaced by a successful compiler or mock tests.
