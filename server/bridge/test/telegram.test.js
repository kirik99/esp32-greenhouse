/**
 * Telegram bot tests (card UI, safety routing, notifications, photo metadata).
 *
 * Everything runs offline and reproducibly:
 *  - Telegram is replaced by a local fake Bot API server (test/helpers/fake-telegram.js);
 *  - MQTT is an in-memory stub that records every publish, so "was a forbidden relay
 *    command sent to the broker?" is directly observable;
 *  - the climate controller is the real one, with its background loops stopped.
 *
 * No real bot token, no real chat, no hardware.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.CLIMATE_STATE_FILE = path.join(os.tmpdir(), `growbox-telegram-test-${process.pid}.json`);

const test = require('node:test');
const assert = require('node:assert/strict');

const { ClimateController, DEFAULT_PROFILES } = require('../automation');
const { createTelegramBot, formatCaption, formatStatus, esc } = require('../telegram');
const { FakeTelegram, sleep } = require('./helpers/fake-telegram');
const { StubMqtt } = require('./helpers/stub-mqtt');
const express = require('express');
const jpeg = require('jpeg-js');
const { installImageUpload } = require('../image-upload');

const CHAT = 777;
const imagesDirs = [];

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test event');
    await sleep(25);
  }
}

test('HTTPS upload resolves /photo exactly once and auto-forwards to authorised chats', async () => {
  const ctx = await startBot({ chatIds: '777,888', autoPhoto: 'on' });
  const token = 'offline-http-upload-test-secret-32';
  const app = express();
  installImageUpload(app, {
    imagesDir: ctx.imagesDir, token, getState: () => ctx.climate.getState(),
    onSaved: ({filename}) => ctx.bot.onImageSaved(filename)
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const image = jpeg.encode({ data: Buffer.from([60,90,120,255]), width: 1, height: 1 }, 85).data;
  const post = secret => fetch(`http://127.0.0.1:${server.address().port}/api/upload-image`, {
    method: 'POST', headers: {'Content-Type':'image/jpeg', 'X-Upload-Token':secret}, body: image
  });
  try {
    feedSensors(ctx.climate, {air_temp: -999, humidity: -999, substrate_temp: 24});
    ctx.tg.sendCommand('/photo');
    await waitFor(() => ctx.bot.hasPendingCapture());
    assert.equal((await post('wrong')).status, 401);
    assert.equal(ctx.bot.hasPendingCapture(), true, 'rejected upload cannot satisfy /photo');
    assert.equal(ctx.tg.photos().length, 0);
    const response = await post(token);
    assert.equal(response.status, 201);
    const first = await response.json();
    await waitFor(() => ctx.tg.photos().length === 1);
    assert.equal(ctx.bot.hasPendingCapture(), false);
    assert.match(ctx.tg.captions()[0], /24\.0 °C/);
    assert.equal(ctx.mqtt.topic('growbox/camera/capture').length, 1);
    const metadata = JSON.parse(fs.readFileSync(path.join(ctx.imagesDir, first.filename+'.json')));
    assert.equal(metadata.mode, 'fruiting');
    assert.equal(metadata.sensors.substrate_temp, 24);
    assert.equal(metadata.transport, 'https');
    await sleep(100);
    assert.equal(ctx.tg.photos().length, 1, 'no duplicate auto photo for requested frame');

    ctx.tg.reset();
    feedSensors(ctx.climate, {substrate_temp: 19});
    ctx.tg.sendCommand('/latest');
    await waitFor(() => ctx.tg.photos().length === 1);
    assert.match(ctx.tg.captions()[0], /24\.0 °C/, 'archive caption must not use live 19 C');
    ctx.tg.reset();
    assert.equal((await post(token)).status, 201);
    await waitFor(() => ctx.tg.photos().length === 2);
    assert.equal(ctx.tg.photos().some(c => /name="chat_id"[^]*?777/.test(c.raw)), true);
    assert.equal(ctx.tg.photos().some(c => /name="chat_id"[^]*?888/.test(c.raw)), true);
    assert.ok(ctx.tg.captions().every(c => /19\.0 °C/.test(c)));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await stopBot(ctx);
  }
});

test('polling retries after a transient startup failure without a bridge restart', async () => {
  const tg = new FakeTelegram();
  await tg.start();
  tg.failMethods.add('getMe');
  const climate = new ClimateController(new StubMqtt());
  climate.stop();
  const bot = createTelegramBot({ climate, mqttClient: new StubMqtt(), imagesDir: os.tmpdir(),
    token: '1:TEST-TOKEN', chatIds: '777', apiRoot: tg.apiRoot, retryDelayMs: 100,
    logger: {log:()=>{}, warn:()=>{}}
  });
  try {
    assert.equal(await bot.ready, false);
    tg.failMethods.delete('getMe');
    tg.sendCommand('/status');
    await waitFor(() => tg.texts().some(t => /Growbox/.test(t)));
  } finally { await bot.stop(); await tg.stop(); }
});

/** Boot the real bot module against stubs. */
async function startBot({ chatIds = String(CHAT), autoPhoto = 'off', failMethods = [], captureTimeoutMs } = {}) {
  const tg = new FakeTelegram();
  await tg.start();
  for (const method of failMethods) tg.failMethods.add(method);

  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-img-'));
  imagesDirs.push(imagesDir);

  const mqtt = new StubMqtt();
  const climate = new ClimateController(mqtt);
  climate.stop();
  climate.mode = 'fruiting';
  climate.modeName = DEFAULT_PROFILES.fruiting.name;

  const logs = [];
  const bot = createTelegramBot({
    climate,
    mqttClient: mqtt,
    imagesDir,
    token: '1:TEST-TOKEN',
    chatIds,
    apiRoot: tg.apiRoot,
    autoPhoto,
    captureTimeoutMs,
    queryHistory: async () => [{ label: '🌡 Воздух', unit: '°C', digits: 1, count: 5, min: 1, max: 3, avg: 2 }],
    launchOptions: { dropPendingUpdates: true },
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) }
  });
  await bot.ready;
  await sleep(120);

  return { tg, mqtt, climate, bot, logs, imagesDir };
}

async function stopBot(ctx) {
  if (ctx.bot) await ctx.bot.stop();
  await ctx.tg.stop();
}

/** Fill the controller with fresh, valid telemetry. */
function feedSensors(climate, overrides = {}) {
  climate.processSensors({
    air_temp: 20, humidity: 60, substrate_temp: 20, co2_ppm: 800, ...overrides
  });
}

/** Write a JPEG-ish frame plus the sidecar metadata the bridge would create. */
function writeFrame(imagesDir, filename, metadata) {
  fs.writeFileSync(path.join(imagesDir, filename), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  if (metadata) fs.writeFileSync(path.join(imagesDir, `${filename}.json`), JSON.stringify(metadata, null, 2));
}

test.after(() => {
  for (const dir of imagesDirs) fs.rmSync(dir, { recursive: true, force: true });
  try { fs.unlinkSync(process.env.CLIMATE_STATE_FILE); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('foreign chat cannot use commands or buttons', async () => {
  const ctx = await startBot();
  try {
    const { tg } = ctx;
    feedSensors(ctx.climate);

    tg.sendCommand('/status', 999);
    await sleep(300);
    const foreign = tg.messages().filter(c => c.json.chat_id === 999);
    assert.equal(foreign.length, 1, 'the stranger gets exactly one answer');
    assert.match(foreign[0].json.text, /Доступ запрещён/);
    assert.equal(tg.texts().some(t => t.includes('Growbox — статус')), false, 'no telemetry leaked');

    tg.reset();
    tg.pressButton('st', 999);
    await sleep(300);
    assert.equal(tg.texts().some(t => t.includes('Growbox — статус')), false);
    assert.equal(tg.messages().some(c => c.json.chat_id === 999 && /Доступ запрещён/.test(c.json.text)), true);

    tg.reset();
    tg.sendCommand('/status', CHAT);
    await sleep(300);
    assert.equal(tg.texts().some(t => t.includes('Growbox — статус')), true, 'authorised chat still works');
  } finally {
    await stopBot(ctx);
  }
});

test('an empty allowlist never leaks data - it only reports the chat id', async () => {
  const ctx = await startBot({ chatIds: '' });
  try {
    feedSensors(ctx.climate);
    ctx.tg.sendCommand('/status', 555);
    await sleep(300);
    const text = ctx.tg.texts().join('\n');
    assert.match(text, /555/);
    assert.match(text, /TELEGRAM_CHAT_ID/);
    assert.equal(text.includes('Growbox — статус'), false);
  } finally {
    await stopBot(ctx);
  }
});

// ---------------------------------------------------------------------------
// Relay safety through the bot
// ---------------------------------------------------------------------------

test('forbidden relay ON from Telegram is refused and never published to MQTT', async () => {
  const ctx = await startBot();
  try {
    const { tg, mqtt, climate } = ctx;

    // OVERHUMIDITY active: humidifier must stay off
    feedSensors(climate, { humidity: 99 });
    mqtt.clear();

    tg.sendCommand('/relay 1 on');
    await sleep(300);
    assert.match(tg.texts().join('\n'), /OVERHUMIDITY/);
    assert.deepEqual(mqtt.relayCommands(), [], 'nothing may be published for a refused ON');

    // The button path must be refused identically
    tg.reset();
    tg.pressButton('rl:1');
    await sleep(300);
    assert.deepEqual(mqtt.relayCommands(), []);
    assert.match(tg.answers().map(a => a.json.text).join('\n'), /OVERHUMIDITY/);

    // Emergency OFF is still allowed through the same paths
    tg.reset();
    tg.sendCommand('/relay 1 off');
    await sleep(300);
    assert.deepEqual(mqtt.relayCommands(), [{ relay: 1, state: false }]);
  } finally {
    await stopBot(ctx);
  }
});

test('heater ON from Telegram is refused without fresh valid telemetry', async () => {
  const ctx = await startBot();
  try {
    const { tg, mqtt, climate } = ctx;
    mqtt.clear();

    // No telemetry at all
    tg.sendCommand('/relay 2 on');
    await sleep(300);
    assert.deepEqual(mqtt.relayCommands(), []);
    assert.match(tg.texts().join('\n'), /SENSOR_FAIL|запрещено/);

    // Stale telemetry
    tg.reset();
    feedSensors(climate);
    climate.lastSensors.updated_at = Date.now() - 10 * 60 * 1000;
    mqtt.clear();
    tg.sendCommand('/relay 2 on');
    await sleep(300);
    assert.deepEqual(mqtt.relayCommands(), []);
    assert.match(tg.texts().join('\n'), /устарел/);
  } finally {
    await stopBot(ctx);
  }
});

test('invalid relay numbers are rejected by command and by button', async () => {
  const ctx = await startBot();
  try {
    const { tg, mqtt, climate } = ctx;
    feedSensors(climate);
    mqtt.clear();

    for (const arg of ['0', '7', '8', '9']) {
      tg.reset();
      tg.sendCommand(`/relay ${arg} on`);
      await sleep(250);
      assert.deepEqual(mqtt.relayCommands(), [], `/relay ${arg} on must not publish`);
      assert.match(tg.texts().join('\n'), /Недопустимый номер реле/);
    }

    for (const data of ['rl:0', 'rl:7', 'rl:8', 'rl:9', 'rl:99']) {
      tg.reset();
      tg.pressButton(data);
      await sleep(250);
      assert.deepEqual(mqtt.relayCommands(), [], `${data} must not publish`);
      assert.match(tg.answers().map(a => a.json.text).join('\n'), /Недопустимый номер реле/);
    }

    // Valid buttons still work
    tg.reset();
    tg.pressButton('rl:4');
    await sleep(250);
    assert.deepEqual(mqtt.relayCommands(), [{ relay: 4, state: true }]);
  } finally {
    await stopBot(ctx);
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test('/notify off suppresses both alarm raise and clear, and does not replay stale transitions', async () => {
  const ctx = await startBot();
  try {
    const { tg, climate, bot } = ctx;
    feedSensors(climate);

    tg.sendCommand('/notify off');
    await sleep(250);
    assert.match(tg.texts().join('\n'), /выключены/);
    tg.reset();

    // Raise - must be silent
    climate.safetyAlert = 'OVERHEAT';
    await bot.checkAlerts();
    await sleep(100);
    assert.deepEqual(tg.texts(), [], 'alarm raise must be suppressed');

    // Clear - must be silent too (this used to leak "Авария устранена")
    climate.safetyAlert = null;
    await bot.checkAlerts();
    await sleep(100);
    assert.deepEqual(tg.texts(), [], 'alarm clear must be suppressed');

    // Re-enable: no stale transition may be replayed
    tg.sendCommand('/notify on');
    await sleep(250);
    tg.reset();
    await bot.checkAlerts();
    await sleep(100);
    assert.deepEqual(tg.texts(), [], 're-enabling must not replay old transitions');

    // A genuinely new transition is delivered again
    climate.safetyAlert = 'OVERHUMIDITY';
    await bot.checkAlerts();
    await sleep(150);
    const delivered = tg.texts().join('\n');
    assert.match(delivered, /АВАРИЯ/);
    assert.match(delivered, /ПЕРЕУВЛАЖНЕНИЕ/);

    // ...and its clearing is delivered as well
    tg.reset();
    climate.safetyAlert = null;
    await bot.checkAlerts();
    await sleep(150);
    assert.match(tg.texts().join('\n'), /Авария устранена/);
  } finally {
    await stopBot(ctx);
  }
});

test('alarm pushes carry a timestamp, readings and quick-action buttons', async () => {
  const ctx = await startBot();
  try {
    const { tg, climate, bot } = ctx;
    feedSensors(climate);
    tg.reset();

    climate.safetyAlert = 'OVERHEAT';
    await bot.checkAlerts();
    await sleep(150);

    const alarm = tg.messages().slice(-1)[0];
    assert.match(alarm.json.text, /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}/);
    assert.match(alarm.json.text, /20\.0 °C/);
    const buttons = (alarm.json.reply_markup?.inline_keyboard || []).flat();
    assert.deepEqual(buttons.map(b => b.callback_data), ['st', 'ph', 'mn']);
  } finally {
    await stopBot(ctx);
  }
});

// ---------------------------------------------------------------------------
// Photo metadata
// ---------------------------------------------------------------------------

test('archived photo uses the readings stored with the frame, not the current ones', async () => {
  const ctx = await startBot();
  try {
    const { tg, climate, imagesDir } = ctx;
    // Live telemetry is deliberately different from the archived metadata
    feedSensors(climate, { air_temp: 25.5, humidity: 77, substrate_temp: 24, co2_ppm: 999 });

    const receivedAt = '2026-10-12T18:00:00.000Z';
    writeFrame(imagesDir, '2026-10-12_21-00-00.jpg', {
      received_at: receivedAt,
      sensors: { air_temp: 11.1, humidity: 42, substrate_temp: 10.4, co2_ppm: 333, pressure: 1001, updated_at: Date.parse('2026-10-12T17:59:30.000Z') },
      mode: 'pinning',
      modeName: 'Инициация (Примордии / Холодовой шок)',
      substate: 'Норма',
      safetyAlert: null
    });

    tg.sendCommand('/latest 1');
    await sleep(350);

    const caption = tg.captions()[0] || '';
    assert.match(caption, /11\.1 °C/, 'archived air temp must come from the sidecar');
    assert.match(caption, /42 %/);
    assert.match(caption, /333 ppm/);
    assert.match(caption, /Инициация/);
    assert.equal(caption.includes('25.5'), false, 'live readings must not be substituted');
    assert.equal(caption.includes('999'), false);
    assert.match(caption, /Получен сервером/, 'receive time must be labelled as such, never as shutter time');
  } finally {
    await stopBot(ctx);
  }
});

test('a frame without metadata never gets invented historical readings', async () => {
  const ctx = await startBot();
  try {
    const { tg, climate, imagesDir } = ctx;
    feedSensors(climate, { air_temp: 25.5, humidity: 77, substrate_temp: 24, co2_ppm: 999 });

    writeFrame(imagesDir, '2026-01-01_00-00-00.jpg'); // no sidecar: legacy frame

    tg.sendCommand('/latest 1');
    await sleep(350);

    const caption = tg.captions()[0] || '';
    assert.match(caption, /Метаданные кадра не найдены/);
    assert.equal(caption.includes('25.5'), false, 'current readings must not be presented as historical');
    assert.equal(caption.includes('77 %'), false);
    assert.equal(caption.includes('999'), false);
  } finally {
    await stopBot(ctx);
  }
});

test('formatCaption labels missing metadata explicitly', () => {
  const legacy = formatCaption({ archived: false, file: 'old.jpg' });
  assert.match(legacy, /Метаданные кадра не найдены/);
  assert.match(legacy, /исторических показаний датчиков нет/);
  assert.equal(legacy.includes('°C'), false);

  const archived = formatCaption({
    archived: true,
    receivedAt: '2026-10-12T18:00:00.000Z',
    sensors: { air_temp: 11.1, humidity: 42, substrate_temp: 10.4, co2_ppm: 333, updated_at: Date.now() },
    modeName: 'Плодоношение',
    file: 'x.jpg'
  });
  assert.match(archived, /Получен сервером/);
  assert.match(archived, /11\.1 °C/);
  assert.equal(archived.includes('снят'), false, 'never claim a capture time we do not have');
});

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

test('dynamic text is escaped in HTML messages', async () => {
  const ctx = await startBot();
  try {
    const { tg, climate } = ctx;
    feedSensors(climate);
    climate.profiles.fruiting.name = 'Pwn <b>bold</b> & "quoted"';

    tg.sendCommand('/status');
    await sleep(300);
    const text = tg.texts().join('\n');
    assert.match(text, /Pwn &lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quoted&quot;/);
    assert.equal(text.includes('<b>bold</b>'), false, 'raw markup must never be injected');

    // Mode list renders profile descriptions too
    climate.profiles.fruiting.description = '<script>alert(1)</script>';
    tg.reset();
    tg.sendCommand('/mode');
    await sleep(300);
    const modes = tg.edits().concat(tg.messages()).map(c => c.json.text || '').join('\n');
    assert.match(modes, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(modes.includes('<script>'), false);

    assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
    assert.match(formatStatus({ mode: 'manual', modeName: '<x>', relays: [], lastSensors: {}, timers: {} }), /&lt;x&gt;/);
  } finally {
    await stopBot(ctx);
  }
});

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

test('Telegram API errors do not take the bot (and therefore the bridge) down', async () => {
  const ctx = await startBot({ failMethods: ['sendMessage'] });
  try {
    const { tg, climate } = ctx;
    feedSensors(climate);

    tg.sendCommand('/status');
    await sleep(300);
    assert.equal(tg.messages().length, 0, 'the failing API call delivered nothing');
    assert.equal(tg.attempts('sendMessage').length, 1, 'the call was attempted and swallowed');

    // The bot keeps serving once the API recovers
    tg.failMethods.delete('sendMessage');
    tg.sendCommand('/help');
    await sleep(300);
    assert.match(tg.texts().join('\n'), /Growbox Bot/);
  } finally {
    await stopBot(ctx);
  }
});

test('a failing getMe does not throw and leaves the bridge alive', async () => {
  const tg = new FakeTelegram();
  await tg.start();
  tg.getMeResult = null;
  tg.failMethods.add('getMe');

  const mqtt = new StubMqtt();
  const climate = new ClimateController(mqtt);
  climate.stop();
  const logs = [];
  const bot = createTelegramBot({
    climate,
    mqttClient: mqtt,
    imagesDir: os.tmpdir(),
    token: '1:TEST-TOKEN',
    chatIds: String(CHAT),
    apiRoot: tg.apiRoot,
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) }
  });

  assert.ok(bot, 'the module still returns a handle');
  const ready = await Promise.race([bot.ready, sleep(1500).then(() => 'timeout')]);
  assert.equal(ready, false, 'readiness resolves false instead of rejecting');
  assert.equal(logs.some(l => /Polling stopped/.test(l)), true, 'the failure is logged, not thrown');

  await bot.stop();
  await tg.stop();
});

test('a request without a token simply disables the bot', () => {
  assert.equal(createTelegramBot({ token: '' }), null);
  assert.equal(createTelegramBot({ token: undefined, logger: { log: () => {} } }), null);
});

test('shutdown releases a pending /photo request instead of hanging it', async () => {
  const ctx = await startBot();
  try {
    const { tg, mqtt, bot } = ctx;
    feedSensors(ctx.climate);

    tg.sendCommand('/photo');
    await sleep(250);
    assert.equal(mqtt.topic('growbox/camera/capture').length, 1, 'capture must be requested');
    assert.equal(bot.hasPendingCapture(), true, 'the bot waits for the frame');

    await bot.stop();
    assert.equal(bot.hasPendingCapture(), false, 'stop() must release the pending request');
    await sleep(100);
    assert.equal(tg.photos().length, 0, 'nothing is sent after shutdown');
  } finally {
    await stopBot(ctx);
  }
});

test('a failed /photo leaves no dangling capture wait, and a retry works', async () => {
  const ctx = await startBot({ failMethods: ['sendChatAction'] });
  try {
    const { tg, mqtt, climate, bot, imagesDir } = ctx;
    feedSensors(climate);

    // 1. The very first API call of the flow fails (the reported repro)
    tg.sendCommand('/photo');
    await sleep(350);
    assert.equal(mqtt.topic('growbox/camera/capture').length, 1, 'the capture was requested');
    assert.equal(bot.hasPendingCapture(), false, 'the failed command must not keep a pending waiter');
    assert.equal(tg.photos().length, 0);
    assert.match(tg.texts().join('\n'), /Ошибка получения снимка/);

    // 2. A frame arriving later must not be delivered to the dead request
    writeFrame(imagesDir, '2026-10-12_23-00-00.jpg', {
      received_at: '2026-10-12T20:00:00.000Z',
      sensors: { air_temp: 11.1, humidity: 42, substrate_temp: 10.4, co2_ppm: 333, updated_at: Date.now() },
      mode: 'fruiting',
      modeName: 'Плодоношение',
      substate: 'Норма'
    });
    bot.onImageSaved('2026-10-12_23-00-00.jpg');
    await sleep(200);
    assert.equal(tg.photos().length, 0, 'the stale request must be gone');

    // 3. Retry after the API recovers: no conflict with the previous attempt
    tg.failMethods.delete('sendChatAction');
    tg.reset();
    tg.sendCommand('/photo');
    await sleep(300);
    assert.equal(mqtt.topic('growbox/camera/capture').length, 2, 'the retry requests a new frame');
    assert.equal(bot.hasPendingCapture(), true, 'the retry owns the waiter');

    writeFrame(imagesDir, '2026-10-12_23-05-00.jpg', {
      received_at: '2026-10-12T20:05:00.000Z',
      sensors: { air_temp: 12.2, humidity: 44, substrate_temp: 11.1, co2_ppm: 222, updated_at: Date.now() },
      mode: 'fruiting',
      modeName: 'Плодоношение',
      substate: 'Норма'
    });
    bot.onImageSaved('2026-10-12_23-05-00.jpg');
    await sleep(350);

    assert.equal(tg.photos().length, 1, 'exactly one photo for the successful retry');
    assert.equal(bot.hasPendingCapture(), false, 'the waiter is released after delivery');
    assert.match(tg.captions()[0], /12\.2 °C/, 'the retry got its own frame');
  } finally {
    await stopBot(ctx);
  }
});

test('a capture timeout clears the waiter and falls back to the archive', async () => {
  const ctx = await startBot({ captureTimeoutMs: 150 });
  try {
    const { tg, mqtt, climate, bot, imagesDir } = ctx;
    feedSensors(climate);

    writeFrame(imagesDir, '2026-10-12_22-00-00.jpg', {
      received_at: '2026-10-12T19:00:00.000Z',
      sensors: { air_temp: 11.1, humidity: 42, substrate_temp: 10.4, co2_ppm: 333, updated_at: Date.now() },
      mode: 'fruiting',
      modeName: 'Плодоношение',
      substate: 'Норма'
    });

    tg.sendCommand('/photo');
    await sleep(600); // no frame from the "ESP32" -> timeout path

    assert.equal(mqtt.topic('growbox/camera/capture').length, 1);
    assert.equal(bot.hasPendingCapture(), false, 'the timeout must release the waiter');
    assert.equal(tg.photos().length, 1, 'the archived frame is sent as a fallback');
    assert.match(tg.captions()[0], /таймаут 0 с|показан последний из архива/);
  } finally {
    await stopBot(ctx);
  }
});

test('auto photo forwarding uses the stored metadata as well', async () => {
  const ctx = await startBot({ autoPhoto: 'on' });
  try {
    const { tg, climate, imagesDir, bot } = ctx;
    feedSensors(climate, { air_temp: 25.5, humidity: 77 });

    writeFrame(imagesDir, '2026-10-12_22-00-00.jpg', {
      received_at: '2026-10-12T19:00:00.000Z',
      sensors: { air_temp: 12.2, humidity: 44, substrate_temp: 11.1, co2_ppm: 222, updated_at: Date.now() },
      mode: 'fruiting',
      modeName: 'Плодоношение',
      substate: 'Норма'
    });

    bot.onImageSaved('2026-10-12_22-00-00.jpg');
    await sleep(350);

    const caption = tg.captions()[0] || '';
    assert.match(caption, /12\.2 °C/);
    assert.match(caption, /222 ppm/);
    assert.match(caption, /Автоснимок/);
    assert.equal(caption.includes('25.5'), false);
  } finally {
    await stopBot(ctx);
  }
});
