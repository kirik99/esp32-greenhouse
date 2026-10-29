const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { DeviceDiagnostics, installDiagnostics, TOPIC_PREFIX, redact } = require('../diagnostics');

const device = 'GrowboxESP32_84C7BB7ADFB4';
const sample = (seq = 1, fields = {}) => ({ protocol: 1, device_id: device, boot_id: '1234abcd', seq,
  uptime_ms: 1000, dropped: 0, level: 'INFO', message: '[CAMERA HTTPS] HTTP 201', ...fields });
const push = (store, seq, fields, packet) => store.ingest(TOPIC_PREFIX + device, Buffer.from(JSON.stringify(sample(seq, fields))), packet);

test('diagnostics validates protocol/topic, payload sizes, retained packets and numeric bounds', () => {
  const invalid = [null, [], {}, sample(0), sample(1, { uptime_ms: -1 }), sample(1, { dropped: 1.5 }),
    sample(1, { level: 'debug' }), sample(1, { message: 'x'.repeat(241) }), sample(1, { boot_id: 'bad' }),
    sample(1, { device_id: 'other' }), sample(1, { message: '' })];
  for (const value of invalid) {
    const s = new DeviceDiagnostics();
    assert.equal(s.ingest(TOPIC_PREFIX + device, Buffer.from(JSON.stringify(value))), false);
    assert.equal(s.rows.length, 0);
  }
  const s = new DeviceDiagnostics();
  assert.equal(push(s, 1, {}, { retain: true }), false);
  assert.equal(s.ingest(TOPIC_PREFIX + device, Buffer.from('x'.repeat(1025))), false);
  assert.equal(s.ingest(TOPIC_PREFIX + device, Buffer.from('{')), false);
  assert.equal(s.ingest(TOPIC_PREFIX + 'wrong', Buffer.from(JSON.stringify(sample()))), false);
  assert.equal(push(s, 1), true);
  assert.equal(push(s, 1), false);
});

test('diagnostics bounds RAM/dedup/device maps and rate; dropped/reboot identities stay visible', () => {
  let now = 1000;
  const s = new DeviceDiagnostics({ capacity: 3, now: () => now });
  for (let seq = 1; seq <= 12; seq++) push(s, seq);
  assert.equal(s.rows.length, 3); assert.equal(s.rows.at(-1).seq, 10); assert.equal(s.rejected, 2);
  now += 1000;
  assert.equal(push(s, 1, { boot_id: 'abcdef12', dropped: 17 }), true);
  assert.equal(s.rows.at(-1).dropped, 17);
  assert.equal(s.snapshot({ after: 1, epoch: s.epoch }).reset, true);
  assert.equal(s.snapshot({ after: 999, epoch: s.epoch }).reset, true);
  assert.equal(s.snapshot({ after: s.nextId - 1, epoch: s.epoch }).rows.length, 0);
  assert.equal(s.snapshot({ after: 999, epoch: '0'.repeat(24) }).rows.length, 3);
  for (let i = 1; i < 8; i++) s.observeStatus({ camera_config: { device_id: 'GrowboxESP32_' + String(i).padStart(12, '0') }, diagnostics: { protocol: 1, enabled: true } });
  assert.equal(s.devices.size, 4);
  assert.equal(s.snapshot().devices[0].supported, true);
  now += 120001; assert.equal(s.snapshot().devices[0].fresh, false);
  for (let i = 1; i < 1100; i++) { now += 1000; push(s, i, { boot_id: 'abcddcba' }); }
  assert.equal(s.seen.size, 1024); assert.equal(s.rows.length, 3);
});

test('redaction removes credentials, URLs, control characters and command payloads before storage', () => {
  const secret = 'device-credential-value';
  const s = new DeviceDiagnostics({ secrets: [secret] });
  push(s, 1, { message: '[LOG] ' + secret });
  assert.equal(JSON.stringify(s.snapshot()).includes(secret), false);
  for (const text of ['[LOG] token=abc', 'Authorization: Bearer secret', '-----BEGIN PRIVATE KEY-----', '[MQTT MSG] topic -> private payload'])
    assert.equal(redact(text), '[sensitive diagnostic omitted]');
  assert.equal(redact('\x1b[31m[CAMERA]\nhttps://host/?x=secret\x00'), '[CAMERA] [URL omitted] ');
});

test('PIN is mandatory even with public telemetry; cursor, download and history reset are safe', async t => {
  const app = express();
  const s = new DeviceDiagnostics({ secrets: ['test-upload-secret'] });
  s.observeStatus({ camera_config: { device_id: device } }); // old firmware reported honestly
  push(s, 1, { message: '[CAMERA] <img src=x onerror=alert(1)> test-upload-secret' });
  installDiagnostics(app, { store: s, mqttConnected: () => true,
    requireAuth: (req, res, next) => req.get('Authorization') === 'Bearer test' ? next() : res.status(401).end() });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port, headers = { Authorization: 'Bearer test' };
  for (const endpoint of ['/api/diagnostics', '/api/diagnostics/download']) assert.equal((await fetch(base + endpoint)).status, 401);
  const response = await fetch(base + '/api/diagnostics', { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const d = await response.json(); assert.equal(d.rows.length, 1); assert.equal(d.mqtt_connected, true);
  assert.equal(d.devices[0].supported, false);
  assert.equal(d.rows[0].message.includes('test-upload-secret'), false);
  for (const query of ['after=-1', 'after=1.2', 'after=9007199254740999', 'epoch=bad', 'path=../../env', 'after=1&after=2'])
    assert.equal((await fetch(base + '/api/diagnostics?' + query, { headers })).status, 400, query);
  const next = await fetch(base + '/api/diagnostics?after=' + d.cursor + '&epoch=' + d.epoch, { headers }).then(r => r.json());
  assert.deepEqual(next.rows, []);
  const download = await fetch(base + '/api/diagnostics/download', { headers });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.match(download.headers.get('content-type'), /^text\/plain/);
  const text = await download.text(); assert.match(text, /boot=1234abcd/); assert.equal(text.includes('test-upload-secret'), false);
  assert.equal((await fetch(base + '/api/diagnostics', { method: 'POST', headers })).status, 404); // no remote shell
});

test('diagnostic ACL is device-write/bridge-read only; browser cannot subscribe to raw logs', () => {
  const acl = fs.readFileSync(path.join(__dirname, '../../mosquitto/acl.conf'), 'utf8');
  const esp = acl.split('user growbox_esp32')[1].split('user growbox_bridge')[0];
  const bridge = acl.split('user growbox_bridge')[1].split('user growbox_web')[0];
  const web = acl.split('user growbox_web')[1];
  assert.match(esp, /topic write growbox\/diagnostics\/\+/);
  assert.match(bridge, /topic read growbox\/diagnostics\/\+/);
  assert.doesNotMatch(web, /diagnostics/);
  const ui = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.match(ui, /output\.textContent = rows\.length/);
  assert.doesNotMatch(ui, /espLogOutput[^\n]*innerHTML/);
});

test('real bridge MQTT handler feeds private diagnostics without publishing control commands', async t => {
  const os = require('node:os'), { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-diagnostics-'));
  const state = path.join(dir, 'climate.json'); fs.writeFileSync(state, JSON.stringify({ mode: 'manual', profiles: {} }));
  const child = spawn(process.execPath, ['test/helpers/diagnostics-child.js'], { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ADMIN_PIN: 'test-pin', PUBLIC_TELEMETRY: 'true', TELEGRAM_BOT_TOKEN: '', IMAGE_UPLOAD_TOKEN: 'log-device-private-credential',
      BRIDGE_PORT: '0', IMAGES_DIR: path.join(dir, 'images'), CLIMATE_STATE_FILE: state, CAMERA_SETTINGS_FILE: path.join(dir, 'camera.json'),
      INFLUXDB_URL: 'http://127.0.0.1:1' } });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.connected) child.send({ shutdown: true });
    let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 5000); })]);
    clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 8000;
  while (!/listening on port (\d+)/.test(output)) { if (Date.now() > deadline) throw Error('Bridge readiness timeout'); await new Promise(r => setTimeout(r, 20)); }
  const base = 'http://127.0.0.1:' + output.match(/listening on port (\d+)/)[1];
  const inject = input => new Promise(resolve => { child.once('message', resolve); child.send(input); });
  const result = await inject({ topic: TOPIC_PREFIX + device, payload: sample(1, { message: '[CAMERA] log-device-private-credential' }) });
  assert.equal(result.published, 0);
  await inject({ topic: TOPIC_PREFIX + device, payload: sample(2), retain: true });
  assert.equal((await fetch(base + '/api/diagnostics')).status, 401); // public telemetry does not expose logs
  const auth = await fetch(base + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pin":"test-pin"}' }).then(r => r.json());
  const data = await fetch(base + '/api/diagnostics', { headers: { Authorization: 'Bearer ' + auth.token } }).then(r => r.json());
  assert.equal(data.rows.length, 1); assert.equal(data.mqtt_connected, true);
  assert.equal(JSON.stringify(data).includes('log-device-private-credential'), false);
});
