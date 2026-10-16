/**
 * Shutdown tests against the real bridge entrypoint (index.js):
 * SIGINT/SIGTERM must stop the Telegram bot and release resources instead of
 * leaving the container hanging.
 *
 * MQTT broker and InfluxDB are intentionally absent - the bridge must still start
 * and stop cleanly without them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FakeTelegram } = require('./helpers/fake-telegram');

const BRIDGE_DIR = path.join(__dirname, '..');
const tmpDirs = [];

function workDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-boot-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Boot the real bridge in a child process and stop it.
 * The signal is emitted in-process (works on Windows too); `osSignal` sends a real
 * signal instead, which is what production docker does.
 */
async function bootAndStop({ signal = 'SIGTERM', emit = true, apiRoot } = {}) {
  const dir = workDir();
  const child = spawn(process.execPath, [path.join('test', 'helpers', 'bridge-child.js')], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      MQTT_HOST: '127.0.0.1', // no broker available - the bridge must tolerate that
      MQTT_PORT: '1883',
      BRIDGE_PORT: '0',
      IMAGES_DIR: path.join(dir, 'images'),
      CLIMATE_STATE_FILE: path.join(dir, 'climate_state.json'),
      INFLUXDB_URL: 'http://127.0.0.1:1',
      TELEGRAM_BOT_TOKEN: apiRoot ? '1:TEST-TOKEN' : '',
      TELEGRAM_CHAT_ID: '777',
      TELEGRAM_API_ROOT: apiRoot || '',
      EMIT_SIGNAL: signal,
      EMIT_AFTER_MS: '1500'
    }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  // Wait until the HTTP server is up, then let the child signal itself
  await new Promise((resolve) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      if (/listening on port/.test(stdout) || Date.now() > deadline) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });

  if (!emit) child.kill(signal);
  const code = await exited;
  return { code, stdout, stderr };
}

test('SIGTERM shuts the bridge down gracefully (bot stopped, exit code 0)', async () => {
  const result = await bootAndStop({ signal: 'SIGTERM' });
  assert.match(result.stdout, /listening on port/, result.stderr);
  assert.match(result.stdout, /Shutting down \(SIGTERM\)/);
  assert.equal(result.code, 0, `expected exit code 0, got ${result.code}\n${result.stderr}`);
});

test('SIGINT shuts the bridge down gracefully', async () => {
  const result = await bootAndStop({ signal: 'SIGINT' });
  assert.match(result.stdout, /Shutting down \(SIGINT\)/);
  assert.equal(result.code, 0);
});

test('an enabled bot is started and stopped with the bridge', async () => {
  const tg = new FakeTelegram();
  await tg.start();
  try {
    const result = await bootAndStop({ signal: 'SIGTERM', apiRoot: tg.apiRoot });
    assert.match(result.stdout, /\[Telegram\] Bot started \(polling\)/, result.stderr);
    assert.match(result.stdout, /Telegram bot stopped/);
    assert.equal(result.code, 0);
    assert.equal(tg.attempts('getMe').length >= 1, true, 'the fake Bot API was contacted');
  } finally {
    await tg.stop();
  }
});

test('a real OS signal stops the bridge (docker uses this path)', {
  skip: process.platform === 'win32' ? 'Windows cannot deliver POSIX signals to a child process' : false
}, async () => {
  const result = await bootAndStop({ signal: 'SIGTERM', emit: false });
  assert.match(result.stdout, /Shutting down \(SIGTERM\)/);
  assert.equal(result.code, 0);
});
