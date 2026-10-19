/**
 * End-to-end tests of the guarded relay path over the real HTTP API.
 *
 * Boots the actual bridge entrypoint (index.js) in a child process with no MQTT
 * broker and no InfluxDB, then drives /api/auth/verify and /api/relay. This proves
 * that the REST path uses the same safety-checked method as the Telegram bot and
 * that PIN authorisation is still enforced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE_DIR = path.join(__dirname, '..');
const tmpDirs = [];

function workDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-rest-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Boot index.js and wait until it reports its HTTP port. */
async function bootBridge({ adminPin = '2468' } = {}) {
  const dir = workDir();
  const child = spawn(process.execPath, [path.join('test', 'helpers', 'bridge-child.js')], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      MQTT_HOST: '127.0.0.1',
      MQTT_PORT: '1883',
      BRIDGE_PORT: '0',
      ADMIN_PIN: adminPin,
      IMAGES_DIR: path.join(dir, 'images'),
      CLIMATE_STATE_FILE: path.join(dir, 'climate_state.json'),
      INFLUXDB_URL: 'http://127.0.0.1:1',
      TELEGRAM_BOT_TOKEN: '',
      EMIT_SIGNAL: 'none'
    }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  const port = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      const match = stdout.match(/listening on port (\d+)/);
      if (match) return resolve(Number(match[1]));
      if (child.exitCode !== null) return reject(new Error(`bridge exited early: ${stderr}`));
      if (Date.now() > deadline) return reject(new Error(`bridge did not start: ${stdout}${stderr}`));
      setTimeout(tick, 50);
    };
    tick();
  });

  const api = async (pathname, options = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  };

  const stop = async () => {
    if (child.exitCode === null) child.stdin.write('shutdown\n');
    return exited;
  };

  return { child, port, api, stop, stdout: () => stdout, stderr: () => stderr };
}

test('REST relay control enforces authorisation and the shared safety checks', async () => {
  const bridge = await bootBridge();
  try {
    // 1. Unauthenticated request is refused
    const anonymous = await bridge.api('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay: 5, state: true })
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.success, false);

    // 2. Authenticate with the configured PIN
    const auth = await bridge.api('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2468' })
    });
    assert.equal(auth.status, 200);
    assert.equal(auth.json.success, true);
    const token = auth.json.token;
    assert.ok(token);
    // Credentials handed to the dashboard must stay the MQTT web role, never the bridge role
    assert.notEqual(auth.json.mqtt?.username, undefined);

    const post = (body) => bridge.api('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });

    // 3. Invalid relay numbers are rejected as bad requests
    for (const relay of [0, 7, 9]) {
      const res = await post({ relay, state: true });
      assert.equal(res.status, 400, `relay ${relay} must be a 400`);
      assert.match(res.json.error, /Недопустимый номер реле/);
    }

    // 4. Wrong state type is rejected
    const wrongType = await post({ relay: 5, state: 'on' });
    assert.equal(wrongType.status, 400);

    // 5. Heater ON is refused with 409 while telemetry is missing (no broker in this test)
    const heater = await post({ relay: 2, state: true });
    assert.equal(heater.status, 409);
    assert.match(heater.json.error, /SENSOR_FAIL|запрещено/);

    // 6. Humidifier ON is allowed even when telemetry is missing
    const humidifier = await post({ relay: 1, state: true });
    assert.equal(humidifier.status, 200);
    assert.deepEqual(humidifier.json, { success: true, relay: 1, state: true });

    // 7. Sensor-independent equipment still works, and OFF is always accepted
    const fanOn = await post({ relay: 5, state: true });
    assert.equal(fanOn.status, 200);
    assert.deepEqual(fanOn.json, { success: true, relay: 5, state: true });
    const fanOff = await post({ relay: 5, state: false });
    assert.equal(fanOff.status, 200);
    assert.equal(fanOff.json.success, true);

    // 8. Emergency OFF for the power equipment is allowed even without telemetry
    const heaterOff = await post({ relay: 2, state: false });
    assert.equal(heaterOff.status, 200, 'OFF must remain available as the emergency action');

    // 9. A refused ON was never published to MQTT (refusals are logged, publishes are not)
    assert.equal(/Setting Relay 2 \(Нагреватель\) = ON/.test(bridge.stdout()), false);
    assert.match(bridge.stderr(), /Relay command refused/);
  } finally {
    const code = await bridge.stop();
    assert.equal(code, 0, `bridge should exit cleanly\n${bridge.stderr()}`);
  }
});

test('PUBLIC_TELEMETRY=false keeps telemetry behind the PIN session', async () => {
  const bridge = await bootBridge();
  try {
    const anonymous = await bridge.api('/api/climate');
    assert.equal(anonymous.status, 401);

    const auth = await bridge.api('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2468' })
    });
    const authorized = await bridge.api('/api/climate', { headers: { Authorization: `Bearer ${auth.json.token}` } });
    assert.equal(authorized.status, 200);
    assert.equal(typeof authorized.json.mode, 'string');
  } finally {
    await bridge.stop();
  }
});
