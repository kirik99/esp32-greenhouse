/**
 * Controller-state persistence tests.
 *
 * The compose stack mounts ./bridge/state into the bridge container and points
 * CLIMATE_STATE_FILE at it, so the active phase must survive a container
 * recreation. These tests boot the real entrypoint twice against the same state
 * file and verify the phase is carried over instead of silently falling back to
 * the default one.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-state-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Boot index.js with a given state file and return an authenticated API client. */
async function bootBridge({ stateFile, adminPin = '2468' }) {
  const child = spawn(process.execPath, [path.join('test', 'helpers', 'bridge-child.js')], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      MQTT_HOST: '127.0.0.1',
      MQTT_PORT: '1883',
      BRIDGE_PORT: '0',
      ADMIN_PIN: adminPin,
      IMAGES_DIR: path.join(workDir(), 'images'),
      CLIMATE_STATE_FILE: stateFile,
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
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };

  const login = async () => {
    const auth = await api('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPin })
    });
    assert.equal(auth.status, 200, 'PIN login must succeed');
    return auth.json.token;
  };

  return { child, api, login, stop: async () => { if (child.exitCode === null) child.stdin.write('shutdown\n'); return exited; }, stdout: () => stdout, stderr: () => stderr };
}

test('the active phase survives a container recreation', async () => {
  const dir = workDir();
  const stateFile = path.join(dir, 'state', 'climate_state.json'); // state dir does not exist yet

  // First run: no state file -> controller starts on its default phase and says so loudly
  const first = await bootBridge({ stateFile });
  let token;
  try {
    token = await first.login();
    const initial = await first.api('/api/climate', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(initial.json.mode, 'fruiting');
    assert.match(first.stderr(), /No persisted state at .*climate_state\.json/, 'the fallback must be logged');

    // Operator switches the phase -> the bridge persists it
    const switched = await first.api('/api/climate/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: 'manual' })
    });
    assert.equal(switched.status, 200);

    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(onDisk.mode, 'manual', 'the state file must live where CLIMATE_STATE_FILE points');
  } finally {
    assert.equal(await first.stop(), 0);
  }

  // Second run simulates `docker compose up -d --build`: same mounted file, new container
  const second = await bootBridge({ stateFile });
  try {
    const secondToken = await second.login();
    const restored = await second.api('/api/climate', { headers: { Authorization: `Bearer ${secondToken}` } });
    assert.equal(restored.json.mode, 'manual', 'the phase must be restored, not reset to fruiting');
    assert.equal(/No persisted state/.test(second.stderr()), false, 'no fallback warning expected');
    assert.match(second.stdout(), /Loaded persisted state\. Active mode: manual/);
  } finally {
    assert.equal(await second.stop(), 0);
  }
});

test('custom setpoints are preserved as well', async () => {
  const dir = workDir();
  const stateFile = path.join(dir, 'climate_state.json');

  const first = await bootBridge({ stateFile });
  try {
    const token = await first.login();
    const updated = await first.api('/api/climate/setpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: 'fruiting', setpoints: { tempTarget: 17.25, humTarget: 87.5 } })
    });
    assert.equal(updated.status, 200);
  } finally {
    await first.stop();
  }

  const second = await bootBridge({ stateFile });
  try {
    const token = await second.login();
    const state = await second.api('/api/climate', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(state.json.profiles.fruiting.tempTarget, 17.25);
    assert.equal(state.json.profiles.fruiting.humTarget, 87.5);
  } finally {
    assert.equal(await second.stop(), 0);
  }
});
