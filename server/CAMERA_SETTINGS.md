# Camera scheduling from the dashboard

Two independent controls live under the camera preview:

- **Reception** decides whether the server accepts new HTTPS or legacy MQTT
  frames. When off, HTTPS returns 503 before parsing/decoding the JPEG; manual
  capture requests and Telegram /photo are refused. Existing archives remain.
- **Auto capture** and the interval (integer 1–1440 minutes) control the ESP's
  schedule. When auto is off and reception is on, manual captures still work.
  Turning reception off requires auto capture off as well.

## Protocol and persistence

GET /api/camera/settings follows telemetry access permissions. PUT requires a
valid PIN session. PUT accepts only reception_enabled, auto_enabled, and
interval_seconds; booleans are strict, and seconds must be a multiple of 60 in
60..86400. Settings are atomically saved in /app/state/camera_settings.json.
Missing or corrupt state defaults to reception OFF / auto OFF / 10 minutes.

After saving, bridge publishes a retained QoS1 command on
growbox/camera/config/set with protocol=1, a unique request_id, auto_enabled, and
interval_seconds. Reconnect republishes the latest desired state, not a queue of
obsolete commands. The browser does not have write access to these MQTT topics.

The ESP applies the latest queued command in its main loop and stores a single
JSON record in Preferences/NVS. A failed NVS write cannot enable auto capture;
disable still takes effect immediately. Exact duplicate commands do not rewrite
flash or reset the capture timer. Settings survive a power cycle, but automatic
capture waits for the server configuration on each boot before starting.

The ESP reports protocol, request_id, auto_enabled, interval_seconds, persisted,
camera_ready, and device_id via growbox/camera/config/state and inside its regular
growbox/status packet. The dashboard only says "confirmed" when the request ID
and values match, persistence succeeded, and the report is less than 120 seconds
old. Broker PUBACK alone is NOT device confirmation. Legacy firmware is explicitly
shown as unsupported. This controller is for a single growbox, like the existing
shared relay topics; multi-device routing is not implemented.

An upload already in progress may finish when only auto capture is disabled.
Disabling reception additionally rechecks policy after the body arrives, before
saving it. A request already saved before the switch remains in the archive.
Telegram auto forwarding remains separate from ESP capture scheduling.

## Upgrade and current temporary pause

1. Back up the existing .env, controller state, camera settings, Compose override,
   nginx configuration, ACLs and running image. Do not replace device secrets.
2. Deploy the bridge, dashboard and MQTT ACL additions. Reload Mosquitto ACLs and
   nginx; do not recreate databases. Preserve the existing manual/biological mode.
3. Flash the updated growbox_s3_cam ONCE, retaining your own wifi_config.h and
   board configuration. This adds camera_settings.cpp/.h and camera_schedule.h.
   A new firmware build defaults to no automatic photo, including startup photos.
4. Keep reception OFF until the new firmware is ready. Log in by PIN, select the
   interval, and save. Confirm that the ESP acknowledgment appears in the dashboard.

On the current LXC an operator-requested temporary exact nginx location returns
503 for /api/upload-image. Keep that block until a deliberate feature deployment;
then remove only that temporary location after verifying that the bridge policy
is OFF. Otherwise nginx would continue blocking uploads even after the dashboard
allows them. Original nginx config is backed up under
/root/growbox-backups/photo-pause-20261015.REtSQn/default.conf on that LXC.

Old firmware still takes/sends photos when the server refuses them. The dashboard
cannot remotely add protocol support; one firmware update is required. Future
interval/auto changes need no further flashing.

## Tests

`cd server/bridge && npm test` covers API authentication, validation, fail-closed
policy, persistence failures, exact fresh acknowledgments, reconnect behavior,
photo blocking and Telegram integration. All endpoints use loopback/mocks.

The portable timing core also has a C++ host test (not a complete ESP build):

```bash
g++ -std=c++17 -Wall -Wextra -Werror growbox_s3_cam/test/camera_schedule_test.cpp -o /tmp/camera-schedule-test
/tmp/camera-schedule-test
```

Hardware validation still needs the full Arduino build and actual ESP: apply
OFF, change interval while ON, reboot, reconnect MQTT, and verify photos do not
interrupt sensor telemetry. No physical relays need to be toggled for this check.
