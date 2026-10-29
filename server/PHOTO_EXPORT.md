# Download camera photos as a ZIP

The deployed static dashboard (`server/index.html`) has a **Скачать архив фото**
collapsible form below the camera gallery. It starts closed to save space; click
the heading (or focus it and press Enter/Space) to expand it. Collapsing it keeps
the selected dates and does not cancel a download. This does not require ESP changes.

1. Sign in with the existing PIN (export stays private even with public telemetry).
2. Select **С даты** / **По дату включительно**, or check **За всё время**.
3. Optionally include JSON sidecars containing the readings saved with each photo.
4. Click **Проверить период** for the photo count and approximate source size.
5. Click **Скачать ZIP**. The normal browser download manager handles the stream.
   The page reports handoff, not a falsely confirmed successful download: inspect
   the browser's download list for completion or interruption.

No photo, state, database or configuration file is modified or deleted by export.
No camera/MQTT/relay command is sent. New photos arriving after the selection are
not added to that download. Preview and preparation are separate snapshots, so
their counts may differ if a new frame arrives between them.

## Date semantics

- All endpoints and the form use the configured server `TZ` (default Europe/Moscow).
- Both calendar dates are inclusive, including their entire days. An ISO sidecar
  `received_at` is converted into that timezone, including daylight-saving rules.
- This is the server receipt time, not an invented camera shutter timestamp.
- For older frames with missing/invalid metadata, a recognised dated filename is
  used first, then the file modification time. The UI reports fallback counts and
  `manifest.json` records the source used per photo. Legacy dated filenames are
  interpreted as the original server-local date; if TZ was changed historically,
  these names cannot recover the original timezone precisely.

## ZIP contents and safety

- `photos/`: original JPG/JPEG/PNG files, unchanged.
- `metadata/`: associated valid JSON sidecars, only when requested.
- `manifest.json`: selected range, timezone, filename/date sources and counts.

Only regular, singly-linked files in the flat image directory are considered.
Symlinks, directories, arbitrary paths, unrelated JSON, environment files and
firmware keys are excluded. Missing/corrupt/oversized sidecars do not prevent
exporting the photo; their timestamps fall back explicitly. No current sensor
readings are substituted for missing historical metadata.

By default, one request allows up to 5000 photos and 512 MiB of source files plus
the manifest. Larger selections require narrower dates. At most two scans/two
downloads and eight pending tickets are allowed per bridge process. Metadata
reads are capped at 64 KiB. Archives use ZIP STORE (JPEGs are already compressed).
Only one source stream is opened at a time; backpressure avoids loading the ZIP
into server RAM or browser JS memory. There is no temporary ZIP file on disk.
Cancelling the browser download aborts work and closes the current source stream.
If a file changes/disappears after preparation, the download fails rather than
silently returning a different file. A late stream error can produce an incomplete
download: prepare the archive again; do not treat a truncated ZIP as success.

## API

- `GET /api/photo-exports/config`: timezone, server date and limits; PIN session.
- `GET /api/photo-exports/preview?from=YYYY-MM-DD&to=YYYY-MM-DD`: count/size; PIN.
  Use `all=1` instead of dates and optional `include_metadata=1`.
- `POST /api/photo-exports`: PIN session, JSON `{from,to,include_metadata}` or
  `{all:true,include_metadata}`. Returns 201 with a short-lived download URL, not
  ZIP bytes. Invalid range => 400, empty period => 404, size/count limit => 413,
  busy => 429. Nothing is queued automatically for a later download.
- `GET /api/photo-exports/<ticket>`: streams ZIP using a random 256-bit capability.
  The ticket expires after two minutes and can be consumed only once (including
  racing GETs). HEAD is refused without consuming it. No long-lived PIN session
  token is put in a download URL. Treat an unused ticket as a temporary secret;
  do not share it. Export responses are `no-store`.

## Deployment and checks

Run `npm ci && npm test` in `server/bridge`, then deploy/rebuild the bridge and
update `server/index.html` together. Reload nginx with the dedicated
`/api/photo-exports/` streaming location in default.conf (or optional https.conf).
It disables local proxy buffering and forwards `X-Accel-Buffering: no` to an
outer proxy such as Nginx Proxy Manager. Any additional proxy must also honour
this hint or disable response buffering for downloads. No volumes, .env secrets,
ESP firmware or MQTT ACL changes are required.

Tests cover exact timezone/day boundaries, legacy timestamps, corrupt metadata,
authentication, a valid extracted ZIP, optional sidecars, no secret/link traversal,
one-use/expired/racing tickets, resource limits, file mutation and cancellation.
The real bridge entrypoint API test covers the authenticated export route too.
