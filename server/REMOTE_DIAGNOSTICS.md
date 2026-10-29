# ESP remote application console

The static dashboard has a collapsed **Консоль ESP** panel. Log in with the
existing PIN, expand it, and inspect camera, HTTPS, MQTT, sensor and safety
messages. Updates are polled every two seconds only while the panel is open,
the tab is visible and the PIN session is unlocked. Pause stops the viewer, not
server ingestion. Filter by severity, turn off auto-scroll, or download the
current server history as UTF-8 text. Logging out clears the browser's copy.

This is **not a remote shell** and cannot execute commands, change relays or
trigger camera captures. It does not fix an existing camera/network fault by
itself: install the diagnostic firmware first, then reproduce the failing action.

## Delivery and limits

- Firmware build 5 (`growbox_s3_cam`) mirrors application `DiagnosticSerial`
  messages to USB and an in-RAM ring of 48 lines, maximum 191 bytes per line.
  Oversized lines are dropped whole, never partially exposing a credential.
- A dedicated low-priority FreeRTOS task sends at most two small packets per
  second via `esp_mqtt_client_enqueue`. Network I/O is never done in the logger's
  write callback, control loop or safety checks. The MQTT outbox budget check is
  8 KiB; diagnostics are best effort and lose messages under load.
- Topic: `growbox/diagnostics/<device_id>`, QoS 0, retain false. Payload:
  `{protocol:1,device_id,boot_id,seq,uptime_ms,dropped,level,message}`.
  `boot_id` is random per boot; `seq` identifies a line within that boot. The
  cumulative `dropped` count includes oversized/overwritten/unqueueable lines.
  Offline logs survive only within the bounded RAM ring and disappear on reset.
- Status includes `diagnostics:{protocol:1,enabled,boot_id,dropped,queued}`. Old
  firmware still works normally; the dashboard explains that it needs updating.
- Bridge accepts only bounded, schema-valid, non-retained packets matching their
  device-specific topic. At most 10 packets/second globally, 500 history rows,
  1024 deduplication IDs and four device status records are kept in RAM. No log
  files or Influx measurements are written. History resets on bridge restart.
- `received_at` is UTC server receipt time, not the original event's wall clock.
  Uptime/boot/sequence preserve device context when buffered lines arrive later.
  Gaps are expected: this is diagnostic assistance, not a reliable audit trail.

## Privacy

MQTT ACL grants ESP write-only and bridge read-only access to diagnostics. Browser
MQTT credentials have **no diagnostic topic permission**, including when public
telemetry is enabled. Both HTTP APIs always require a PIN session, reject query
tokens and use `Cache-Control: no-store`.

Firmware suppresses credential/URL/command-payload lines and exact configured
Wi-Fi/MQTT/upload/download secrets before MQTT publication. Wi-Fi identity
details remain USB-only. The bridge performs additional credential, URL, opaque
value, control-character and ANSI filtering. The UI uses textContent, not HTML.
Do not add raw credential prints: filtering is defense in depth, not permission
to print secrets. USB serial retains the original local output.

ROM/bootloader output, panic dumps and third-party ESP-IDF/Arduino library output
are **not** automatically mirrored. Application HTTPS errors now include open /
write results, errno, heap/RSSI and elapsed time without the URL or token. When
Wi-Fi or MQTT is down, there is no live remote view. The separate task continues
to drain queued application lines even if a photo worker is blocked, provided
MQTT remains operational. A hung CPU or logger task still requires local access.

## API

- `GET /api/diagnostics?after=<server-row-id>&epoch=<server-epoch>`: rows after the
  cursor, current status and limits. A changed epoch, expired cursor or future
  cursor returns `reset:true` and the available history. Omit both on first read.
- `GET /api/diagnostics/download`: bounded UTF-8 text attachment of the server
  history, including boot ID, original sequence, uptime and loss count.
- No unauthenticated stream, remote command endpoint or token-in-URL transport.

## Rollout

1. Build/test bridge and update its code plus `server/index.html` together.
2. Update the **active** mosquitto ACL with the two diagnostics grants and reload
   Mosquitto's configuration (`SIGHUP`). Preserve existing custom users/rules.
3. Compile build 5 with the device's existing private `wifi_config.h`, board,
   partition, flash, PSRAM, TLS and OTA settings. Keep signing keys out of Git.
4. Perform the normal signed OTA only with explicit approval and the existing
   safety preconditions (manual mode, all relays off, compatible slot/rollback).
5. After reboot, verify status support and new lines in the console. No new .env
   tokens, new ports, database migrations or Telegram settings are required.

Verification: `npm test` in `server/bridge`; and from the repository root:
`g++ -std=c++17 -Wall -Wextra -Werror growbox_s3_cam/test/diagnostic_buffer_test.cpp -o /tmp/diagnostic-buffer-test && /tmp/diagnostic-buffer-test`.
