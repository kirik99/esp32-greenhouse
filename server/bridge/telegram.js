/**
 * telegram.js - Telegram bot interface for Growbox OS
 *
 * Runs inside the bridge process, so it reads the live climate state and the
 * image archive directly (single source of truth, no duplicated MQTT/InfluxDB clients).
 *
 * Commands:
 *   /status               - current sensors, mode, relays and timers with time stamps
 *   /photo                - trigger a snapshot over MQTT; wait for its HTTPS upload
 *   /latest [n]           - resend the newest n snapshots from the archive (no capture)
 *   /mode [id]            - show phases / switch phase (incubation|pinning|fruiting|manual)
 *   /relay <1-6> <on|off> - manual relay control (recommend /mode manual first)
 *   /stats [hours]        - min/avg/max of the last N hours (default 24) from InfluxDB
 *   /notify <on|off>      - enable/disable emergency alarm push messages
 *   /help                 - command list
 *
 * Emergency alarms (OVERHEAT / OVERHUMIDITY / SENSOR_FAIL) are pushed to every
 * authorised chat as soon as the controller raises them, and once more when cleared.
 */

const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const { RELAY_NAMES } = require('./automation');
const { readImageMetadata: readStoredMetadata } = require('./image-metadata');

const ALARM_TEXT = {
  OVERHEAT: 'ПЕРЕГРЕВ (воздух/субстрат)',
  OVERHUMIDITY: 'ПЕРЕУВЛАЖНЕНИЕ (отсечка увлажнителя)',
  SENSOR_FAIL: 'СБОЙ ДАТЧИКА ТЕМПЕРАТУРЫ'
};

const CAPTURE_TIMEOUT_MS = 60000;
const ALERT_POLL_MS = 5000;

/**
 * TELEGRAM_AUTO_PHOTO: off (default) | on (every frame from ESP32) | <minutes> (throttled)
 * Returns null for an unparsable value.
 */
function parseAutoPhoto(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['', 'off', 'false', 'no', 'none', '0'].includes(v)) return { enabled: false, minIntervalMs: 0, label: 'выключена', short: 'выкл' };
  if (['on', 'true', 'yes', 'all', '1'].includes(v)) return { enabled: true, minIntervalMs: 0, label: 'каждый кадр', short: 'каждый кадр' };
  const minutes = Number(v);
  if (Number.isFinite(minutes) && minutes > 1) {
    return { enabled: true, minIntervalMs: minutes * 60000, label: `не чаще ${minutes} мин`, short: `${minutes} мин` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure functions)
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/**
 * Escape dynamic values before embedding them into parse_mode: 'HTML' messages.
 * Any user/device controlled string (profile names, filenames, error messages)
 * MUST go through this to avoid breaking the markup or injecting entities.
 */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Local time in the container timezone (TZ env), independent of ICU locales. */
function fmtTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtNum(value, digits = 1) {
  if (value === null || value === undefined || Number(value) <= -900) return '—';
  return Number(value).toFixed(digits);
}

function fmtAge(ms) {
  if (!ms) return 'нет данных';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 90) return `${sec} с назад`;
  if (sec < 5400) return `${Math.round(sec / 60)} мин назад`;
  return `${(sec / 3600).toFixed(1)} ч назад`;
}

function fmtSensorsLine(sensors) {
  return `🌡 ${fmtNum(sensors?.air_temp)} °C · 💧 ${fmtNum(sensors?.humidity, 0)} % · ` +
    `🌱 ${fmtNum(sensors?.substrate_temp)} °C · 🫧 ${fmtNum(sensors?.co2_ppm, 0)} ppm`;
}

function fmtAlarmLine(state) {
  if (!state?.safetyAlert) return '✅ Аварий нет';
  return `🚨 ${esc(ALARM_TEXT[state.safetyAlert] || state.safetyAlert)}`;
}

/** Full status message: readings + stamps. */
function formatStatus(state) {
  const s = state.lastSensors || {};
  const t = state.timers || {};
  const relays = (state.relays || []).map((on, i) => `${i + 1}${on ? '🟢' : '⚪'}`).join(' ');

  return [
    '<b>📊 Growbox — статус</b>',
    `<b>🕒 ${fmtTime()}</b>`,
    '',
    `<b>Датчики</b> (обновлено: ${fmtAge(s.updated_at)})`,
    `🌡 Воздух: <b>${fmtNum(s.air_temp)} °C</b>`,
    `💧 Влажность: <b>${fmtNum(s.humidity)} %</b>`,
    `🌱 Субстрат: <b>${fmtNum(s.substrate_temp)} °C</b>`,
    `🫧 CO₂: <b>${fmtNum(s.co2_ppm, 0)} ppm</b>`,
    `🎚 Давление: ${fmtNum(s.pressure)} hPa`,
    '',
    '<b>Климат</b>',
    `🧠 Режим: <b>${esc(state.modeName || state.mode)}</b> (${esc(state.mode)})`,
    `⚙️ Фаза: ${esc(state.substate) || '—'}`,
    fmtAlarmLine(state),
    '',
    `<b>Реле</b> (${relays})`,
    ...RELAY_NAMES.map((name, i) => `${i + 1}. ${esc(name)}: ${state.relays?.[i] ? 'ВКЛ' : 'выкл'}`),
    '',
    '<b>Таймеры</b>',
    `💨 Блокировка тумана: ${t.mistLockRemainingSec ? `${t.mistLockRemainingSec} с` : '—'}`,
    `🔥 Охлаждение ТЭНа: ${t.heaterCooldownRemainingSec ? `${t.heaterCooldownRemainingSec} с` : '—'}`,
    `🌬 Следующий FAE: ${t.nextFaeInSec !== undefined ? `${Math.round(t.nextFaeInSec / 60)} мин` : '—'}`,
    `🫧 Продувка CO₂: ${t.isPurgingCo2 ? 'активна' : 'нет'}`
  ].join('\n');
}

/**
 * Caption for an archived frame.
 *
 * The firmware does not send a capture time, so `receivedAt` is the moment the
 * bridge stored the frame. Readings come from the sidecar metadata written next
 * to the image at that moment - never from the current sensor state.
 */
function formatCaption(meta) {
  const m = meta || {};
  const lines = [`📷 <b>Growbox — снимок</b>`];

  if (m.receivedAt) {
    lines.push(`🕒 Получен сервером: <b>${fmtTime(m.receivedAt)}</b>`);
  } else {
    lines.push('🕒 Время получения: <i>неизвестно</i>');
  }

  if (m.archived) {
    lines.push(fmtSensorsLine(m.sensors));
    if (m.sensorsUpdatedAt) lines.push(`<i>показания на момент получения, ${fmtAge(m.sensorsUpdatedAt)}</i>`);
  } else {
    lines.push('ℹ️ <i>Метаданные кадра не найдены (кадр сохранён до включения их сбора) — исторических показаний датчиков нет.</i>');
  }

  if (m.modeName || m.mode) lines.push(`🧠 ${esc(m.modeName || m.mode)}${m.substate ? ` • ${esc(m.substate)}` : ''}`);
  if (m.archived) lines.push(fmtAlarmLine(m));
  if (m.file) lines.push(`📁 <code>${esc(m.file)}</code>`);
  return lines.filter(Boolean).join('\n');
}

function formatModes(profiles, active) {
  const lines = ['<b>🧠 Фазы выращивания</b>', `Текущая: <b>${esc(MODE_LABELS[active] || active)}</b>`, ''];
  for (const [id, p] of Object.entries(profiles || {})) {
    lines.push(`${id === active ? '▶️' : '▫️'} <b>${esc(MODE_LABELS[id] || id)}</b> — <code>${esc(id)}</code>${p.description ? `\n     <i>${esc(p.description)}</i>` : ''}`);
  }
  lines.push('', 'Выберите фазу кнопкой ниже или командой <code>/mode &lt;id&gt;</code>.');
  return lines.join('\n');
}

function formatStats(hours, summary) {
  if (!summary || !summary.length) {
    return `📈 За последние ${hours} ч данных в InfluxDB не найдено.`;
  }
  const lines = [`<b>📈 Статистика за ${hours} ч</b>`, '', 'Метрика │ мин │ сред │ макс │ точек'];
  for (const row of summary) {
    lines.push(`${row.label}: ${fmtNum(row.min, row.digits)} / <b>${fmtNum(row.avg, row.digits)}</b> / ${fmtNum(row.max, row.digits)} ${row.unit} (${row.count})`);
  }
  return lines.join('\n');
}

const MODE_LABELS = {
  incubation: '🌱 Инкубация',
  pinning: '❄️ Инициация',
  fruiting: '🍄 Плодоношение',
  manual: '🛠 Ручной'
};

// ---------------------------------------------------------------------------
// Inline keyboards (Bot API 9.4+ renders `style`: danger / success / primary)
// ---------------------------------------------------------------------------

function btn(text, callback_data, style) {
  return style ? { text, callback_data, style } : { text, callback_data };
}

function mainKeyboard(state, ui) {
  const { alertsEnabled, auto } = ui;
  return [
    [btn('🔄 Обновить', 'st'), btn('📷 Снимок', 'ph', 'primary'), btn('📈 Статистика', 'stats:24')],
    [btn('🧠 Фаза', 'mn'), btn('🔌 Реле', 'rl'), btn('📁 Галерея', 'gal')],
    [
      btn(`🔔 Аварии: ${alertsEnabled ? 'вкл' : 'выкл'}`, 'nt', alertsEnabled ? undefined : 'danger'),
      btn(`🤖 Автофото: ${auto.enabled ? auto.short : 'выкл'}`, 'ap', auto.enabled ? 'success' : undefined)
    ]
  ];
}

function modeKeyboard(state) {
  const ids = Object.keys(state.profiles || {});
  const rows = [];
  for (let i = 0; i < ids.length; i += 2) {
    rows.push(ids.slice(i, i + 2).map((id) => btn(
      `${id === state.mode ? '✓ ' : ''}${MODE_LABELS[id] || id}`,
      `md:${id}`,
      id === state.mode ? 'primary' : undefined
    )));
  }
  rows.push([btn('⬅️ В меню', 'back')]);
  return rows;
}

function relayKeyboard(state) {
  const rows = (state.relays || []).map((on, i) => [btn(
    `${i + 1} ${on ? '✅' : '⚪'} ${RELAY_NAMES[i]}`,
    `rl:${i + 1}`,
    on ? 'success' : undefined
  )]);
  rows.push([btn('🔄 Обновить', 'rl'), btn('⬅️ В меню', 'back')]);
  return rows;
}

function statsKeyboard(hours) {
  return [
    [6, 24, 72].map((h) => btn(`${h} ч`, `stats:${h}`, h === hours ? 'primary' : undefined)),
    [btn('🔄 Обновить', `stats:${hours}`), btn('⬅️ В меню', 'back')]
  ];
}

function photoKeyboard() {
  return [[btn('📷 Ещё снимок', 'ph', 'primary'), btn('📁 Галерея', 'gal'), btn('⬅️ В меню', 'back')]];
}

function alarmKeyboard() {
  return [[btn('📊 Статус', 'st', 'primary'), btn('📷 Снимок', 'ph'), btn('🧠 Фаза', 'mn')]];
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

function parseChatIds(raw) {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (Number.isFinite(Number(v)) ? Number(v) : v));
}

/**
 * @param {object} deps
 * @param {object} deps.climate         ClimateController instance (getState/setMode/manualSetRelay)
 * @param {object} deps.mqttClient      connected mqtt client (capture trigger)
 * @param {string} deps.imagesDir       archive directory
 * @param {string} deps.token           Telegram bot token (empty => disabled)
 * @param {string} deps.chatIds         comma separated allowlist
 * @param {string} [deps.apiRoot]       override Bot API root (tests / local Bot API server)
 * @param {function} [deps.queryHistory] async (hours) => summary rows for /stats
 * @param {object} [deps.launchOptions] telegraf.launch() options
 * @param {object} [deps.logger]
 */
function createTelegramBot(deps) {
  const {
    climate,
    mqttClient,
    imagesDir,
    token = process.env.TELEGRAM_BOT_TOKEN,
    chatIds = process.env.TELEGRAM_CHAT_ID,
    apiRoot = process.env.TELEGRAM_API_ROOT,
    queryHistory,
    autoPhoto = process.env.TELEGRAM_AUTO_PHOTO,
    captureTimeoutMs = Number(process.env.TELEGRAM_CAPTURE_TIMEOUT_MS) || CAPTURE_TIMEOUT_MS,
    retryDelayMs = 30000,
    launchOptions = { dropPendingUpdates: true },
    logger = console
  } = deps || {};

  if (!token) {
    logger.log('[Telegram] TELEGRAM_BOT_TOKEN is not set - bot disabled');
    return null;
  }

  const allowed = parseChatIds(chatIds);
  const bot = new Telegraf(token, apiRoot ? { telegram: { apiRoot } } : undefined);

  let alertsEnabled = true;
  let lastAlert = null;
  let pendingCapture = null; // waiter for the next frame: { resolve, timer, settled }
  let captureInFlight = false;

  let auto = parseAutoPhoto(autoPhoto);
  if (!auto) {
    logger.warn(`[Telegram] Unrecognised TELEGRAM_AUTO_PHOTO value "${autoPhoto}" - auto photos disabled`);
    auto = parseAutoPhoto('off');
  }
  let lastAutoSentAt = 0;
  let stopping = false;
  let retryTimer = null;
  let firstLaunch = true;
  const forwarded = new Set(); // filenames already delivered, prevents double sends

  // Never let the bot token reach the container logs, even inside a library error message.
  const redact = (message) => String(message)
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<bot-token>')
    .replace(/(token=)[^&\s]+/gi, '$1<bot-token>');

  const log = (msg) => logger.log(`[${new Date().toISOString()}] [Telegram] ${redact(msg)}`);

  // -- image archive helpers ------------------------------------------------
  function listImages() {
    try {
      return fs.readdirSync(imagesDir)
        .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
        .sort()
        .reverse();
    } catch (err) {
      log(`Cannot read images dir: ${err.message}`);
      return [];
    }
  }

  /**
   * Metadata stored next to the frame by the bridge at receive time.
   * Returns null for frames captured before metadata collection existed, so the
   * caption can state that historical readings are unavailable instead of
   * pretending the current readings belong to that photo.
   */
  function readImageMetadata(filename) {
    try {
      return readStoredMetadata(path.join(imagesDir, filename));
    } catch (err) {
      log(err.message);
      return null;
    }
  }

  async function sendPhoto(chatId, filename, note, replyMarkup) {
    const filepath = path.join(imagesDir, filename);
    if (!fs.existsSync(filepath)) {
      throw new Error(`Файл ${filename} не найден`);
    }
    const meta = readImageMetadata(filename) || { archived: false, file: filename };
    meta.file = filename;
    const options = {
      caption: note ? `${formatCaption(meta)}\n\n${note}` : formatCaption(meta),
      parse_mode: 'HTML'
    };
    if (replyMarkup) options.reply_markup = { inline_keyboard: replyMarkup };
    await bot.telegram.sendPhoto(chatId, { source: fs.createReadStream(filepath) }, options);
    forwarded.add(filename);
  }

  // -- cards & inline UI ----------------------------------------------------
  const uiState = () => ({ alertsEnabled, auto });

  const statusCard = () => formatStatus(climate.getState());

  function relayCard() {
    const state = climate.getState();
    const lines = [
      '<b>🔌 Управление реле</b>',
      `Фаза: <b>${esc(state.modeName)}</b> ${state.mode === 'manual' ? '(ручное управление)' : '(автоматика)'}`,
      ''
    ];
    (state.relays || []).forEach((on, i) => lines.push(`${i + 1}. ${esc(RELAY_NAMES[i])} — <b>${on ? 'ВКЛ' : 'выкл'}</b>`));
    lines.push('', state.mode === 'manual'
      ? 'Нажмите реле, чтобы переключить.'
      : '⚠️ Активна автоматика — контроллер может вернуть реле в рабочее состояние. Для ручного управления включите <b>🛠 Ручной</b>.');
    return lines.join('\n');
  }

  /** Edits the originating card in place; callbacks from photos get a fresh card. */
  async function showCard(ctx, text, keyboard) {
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    const msg = ctx.callbackQuery?.message;
    if (msg?.text !== undefined) {
      try {
        await ctx.editMessageText(text, opts);
        return;
      } catch (err) {
        if (/not modified/i.test(err.message)) return;
        log(`editMessageText failed (${err.message}), sending a new card`);
      }
    }
    await ctx.reply(text, opts);
  }

  /** Toggles only change the keyboard, so the card text is left untouched. */
  async function showKeyboard(ctx, keyboard) {
    const msg = ctx.callbackQuery?.message;
    if (msg?.text !== undefined) {
      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: keyboard });
        return;
      } catch (err) {
        if (/not modified/i.test(err.message)) return;
        log(`editMessageReplyMarkup failed (${err.message}), sending a new card`);
      }
    }
    await ctx.reply('⚙️ Настройки обновлены', { reply_markup: { inline_keyboard: keyboard } });
  }

  /**
   * Register a one-shot waiter for the next frame from the ESP32.
   * The waiter is always released through `resolve()` - either by the frame itself,
   * by the timeout, or by abortPendingCapture() on any error/shutdown path - so a
   * failed /photo can never leave a dangling timer behind.
   */
  function beginCaptureWait() {
    let release;
    const waiter = {
      settled: false,
      timer: null,
      resolve: (filename) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        if (pendingCapture === waiter) pendingCapture = null;
        release(filename);
      }
    };

    const promise = new Promise((resolve) => { release = resolve; });
    waiter.timer = setTimeout(() => waiter.resolve(null), captureTimeoutMs);
    pendingCapture = waiter;
    return { promise, waiter };
  }

  /** Release a pending /photo request (idempotent; never touches a newer request). */
  function abortPendingCapture(waiter) {
    if (!pendingCapture) return;
    if (waiter && pendingCapture !== waiter) return;
    pendingCapture.resolve(null);
  }

  async function captureAndSend(ctx) {
    if (captureInFlight) {
      await ctx.reply('⏳ Предыдущий снимок ещё в обработке, подождите…');
      return;
    }
    captureInFlight = true;
    let waiter = null;
    try {
      const wait = beginCaptureWait();
      waiter = wait.waiter;

      mqttClient.publish('growbox/camera/capture', '1');
      log(`Capture requested by chat ${ctx.chat.id}`);
      await ctx.replyWithChatAction('upload_photo');

      const filename = await wait.promise;
      if (stopping) return; // bridge is shutting down - release the handler

      if (filename) {
        await sendPhoto(ctx.chat.id, filename, null, photoKeyboard());
        return;
      }

      const fallback = listImages()[0];
      if (fallback) {
        await sendPhoto(ctx.chat.id, fallback, `⚠️ ESP32 не прислал свежий кадр (таймаут ${Math.round(captureTimeoutMs / 1000)} с) — показан последний из архива.`, photoKeyboard());
      } else {
        await ctx.reply('⚠️ Снимок не получен: ESP32 offline или камера недоступна. Архив пуст.');
      }
    } catch (err) {
      log(`Capture failed: ${err.message}`);
      if (!stopping) await ctx.reply(`⛔ Ошибка получения снимка: ${esc(err.message)}`, { parse_mode: 'HTML' });
    } finally {
      // Any failure (refused sendChatAction, MQTT publish error, ...) must release
      // the waiter, otherwise the next /photo would race with the stale one.
      abortPendingCapture(waiter);
      captureInFlight = false;
    }
  }

  async function sendGallery(ctx, count) {
    const files = listImages().slice(0, count);
    if (!files.length) {
      await ctx.reply('📁 Архив снимков пуст.');
      return;
    }
    for (let i = 0; i < files.length; i++) {
      const last = i === files.length - 1;
      try {
        await sendPhoto(ctx.chat.id, files[i], `📁 Архив (${i + 1}/${files.length})`, last ? photoKeyboard() : undefined);
      } catch (err) {
        await ctx.reply(`⛔ ${esc(files[i])}: ${esc(err.message)}`, { parse_mode: 'HTML' });
      }
    }
  }

  /** Forward frames received over HTTPS or legacy MQTT (TELEGRAM_AUTO_PHOTO). */
  async function forwardAutoPhoto(filename) {
    if (stopping || !auto.enabled || !allowed.length) return;
    if (forwarded.has(filename)) return;
    if (auto.minIntervalMs && Date.now() - lastAutoSentAt < auto.minIntervalMs) {
      log(`Auto photo ${filename} skipped (throttle ${auto.label})`);
      return;
    }
    if (forwarded.size > 200) forwarded.clear();

    let delivered = 0;
    for (const chatId of allowed) {
      try {
        await sendPhoto(chatId, filename, '🤖 Автоснимок ESP32 (по расписанию камеры)');
        delivered++;
      } catch (err) {
        log(`Cannot send auto photo to ${chatId}: ${err.message}`);
      }
    }
    if (delivered) {
      lastAutoSentAt = Date.now();
      forwarded.add(filename);
      log(`Auto photo ${filename} delivered to ${delivered} chat(s)`);
    }
  }

  // -- auth -----------------------------------------------------------------
  function isAllowed(chatId) {
    return allowed.includes(chatId) || allowed.includes(String(chatId));
  }

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!allowed.length) {
      await ctx.reply(
        `⛔ Бот не привязан к чату.\nВаш chat id: <code>${chatId}</code>\n` +
        'Добавьте его в <code>TELEGRAM_CHAT_ID</code> в server/.env и перезапустите bridge.',
        { parse_mode: 'HTML' }
      );
      return;
    }
    if (!isAllowed(chatId)) {
      log(`Rejected message from unauthorised chat ${chatId}`);
      await ctx.reply(`⛔ Доступ запрещён. Ваш chat id: ${chatId}`);
      return;
    }
    return next();
  });

  // -- commands -------------------------------------------------------------
  const HELP = [
    '<b>🤖 Growbox Bot</b>',
    '',
    'Меню с кнопками: /start или /menu',
    '',
    '/status — датчики, режим, реле, таймеры (с метками времени)',
    '/photo — сделать и прислать свежий снимок с данными',
    '/latest [n] — прислать n последних снимков из архива',
    '/mode — список фаз · /mode &lt;id&gt; — переключить',
    '/relay &lt;1-6&gt; &lt;on|off&gt; — ручное управление реле',
    '/stats [часы] — мин/сред/макс из InfluxDB (по умолчанию 24 ч)',
    '/autophoto [off | on | мин] — автоснимки ESP32 (по умолчанию off)',
    '/notify &lt;on|off&gt; — аварийные push-уведомления',
    '/help — эта справка'
  ].join('\n');

  bot.start(async (ctx) => {
    await showCard(ctx, statusCard(), mainKeyboard(climate.getState(), uiState()));
  });
  bot.help((ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  bot.command('status', async (ctx) => {
    await showCard(ctx, statusCard(), mainKeyboard(climate.getState(), uiState()));
  });

  bot.command('menu', async (ctx) => {
    await showCard(ctx, statusCard(), mainKeyboard(climate.getState(), uiState()));
  });

  bot.command('mode', async (ctx) => {
    const arg = (ctx.message.text.split(/\s+/)[1] || '').trim().toLowerCase();
    if (arg) {
      try {
        climate.setMode(arg);
        log(`Mode switched to ${arg} by chat ${ctx.chat.id}`);
      } catch (err) {
        await ctx.reply(`⛔ ${esc(err.message)}\nДоступные: ${esc(Object.keys(climate.getState().profiles).join(', '))}`, { parse_mode: 'HTML' });
        return;
      }
    }
    const state = climate.getState();
    await showCard(ctx, formatModes(state.profiles, state.mode), modeKeyboard(state));
  });

  // Shared, safety-checked entry point for every manual relay action (commands and buttons)
  function applyRelayCommand(relayId, state, source) {
    const result = climate.manualSetRelay(relayId, state, source);
    if (result.ok) log(`Relay ${relayId} -> ${state ? 'ON' : 'OFF'} via ${source}`);
    return result;
  }

  bot.command('relay', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const id = Number(parts[0]);
    const desired = /^(on|1|вкл(true)?|включить)$/i.test(parts[1] || '');
    const off = /^(off|0|выкл(false)?|выключить)$/i.test(parts[1] || '');
    const hasArgs = Boolean(parts[0]);

    if (hasArgs && !(desired || off)) {
      await ctx.reply('Использование: <code>/relay 3 on</code> или <code>/relay 3 off</code> (1..6)', { parse_mode: 'HTML' });
      return;
    }

    if (hasArgs) {
      const result = applyRelayCommand(id, desired && !off, `telegram command (chat ${ctx.chat.id})`);
      if (!result.ok) {
        await ctx.reply(`⛔ ${esc(result.error)}`, { parse_mode: 'HTML' });
        return;
      }
      await ctx.reply(
        `${off ? '⚪' : '🟢'} Реле ${result.relay} (${esc(RELAY_NAMES[result.relay - 1])}) → <b>${off ? 'ВЫКЛ' : 'ВКЛ'}</b>`,
        { parse_mode: 'HTML' }
      );
    }

    await showCard(ctx, relayCard(), relayKeyboard(climate.getState()));
  });

  bot.command('photo', async (ctx) => {
    await captureAndSend(ctx);
  });

  bot.command('latest', async (ctx) => {
    const arg = Number((ctx.message.text.split(/\s+/)[1] || '1'));
    const count = Number.isInteger(arg) ? Math.min(Math.max(arg, 1), 5) : 1;
    await sendGallery(ctx, count);
  });

  bot.command('stats', async (ctx) => {
    const arg = Number((ctx.message.text.split(/\s+/)[1] || '24'));
    const hours = Number.isFinite(arg) ? Math.min(Math.max(arg, 1), 168) : 24;
    if (!queryHistory) {
      await ctx.reply('⛔ История недоступна (InfluxDB не подключена).');
      return;
    }
    try {
      const summary = await queryHistory(hours);
      await showCard(ctx, formatStats(hours, summary), statsKeyboard(hours));
    } catch (err) {
      await ctx.reply(`⛔ Ошибка запроса InfluxDB: ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('autophoto', async (ctx) => {
    const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
    if (!arg) {
      await ctx.reply(
        `📷 Автоотправка снимков ESP32: <b>${auto.enabled ? auto.label : 'выключена'}</b>\n` +
        'Переключение: <code>/autophoto off</code> · <code>/autophoto on</code> · <code>/autophoto 30</code> (не чаще 30 мин)',
        { parse_mode: 'HTML' }
      );
      return;
    }
    const parsed = parseAutoPhoto(arg);
    if (!parsed) {
      await ctx.reply('⛔ Ожидается: <code>off</code> · <code>on</code> · или число минут (например <code>30</code>)', { parse_mode: 'HTML' });
      return;
    }
    auto = parsed;
    lastAutoSentAt = 0;
    log(`Auto photo ${auto.enabled ? auto.label : 'disabled'} by chat ${ctx.chat.id}`);
    await ctx.reply(`📷 Автоотправка снимков: <b>${auto.enabled ? auto.label : 'выключена'}</b>`, { parse_mode: 'HTML' });
  });

  bot.command('notify', async (ctx) => {
    const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
    if (!['on', 'off'].includes(arg)) {
      await ctx.reply(`Уведомления об авариях: <b>${alertsEnabled ? 'включены' : 'выключены'}</b>\nПереключение: <code>/notify on</code> | <code>/notify off</code>`, { parse_mode: 'HTML' });
      return;
    }
    alertsEnabled = arg === 'on';
    await ctx.reply(`🔔 Уведомления об авариях ${alertsEnabled ? 'включены' : 'выключены'}.`);
  });

  // -- inline buttons -------------------------------------------------------
  const mainMenu = () => mainKeyboard(climate.getState(), uiState());

  bot.action('st', async (ctx) => {
    await ctx.answerCbQuery();
    await showCard(ctx, statusCard(), mainMenu());
  });

  bot.action('back', async (ctx) => {
    await ctx.answerCbQuery();
    await showCard(ctx, statusCard(), mainMenu());
  });

  bot.action('mn', async (ctx) => {
    await ctx.answerCbQuery();
    const state = climate.getState();
    await showCard(ctx, formatModes(state.profiles, state.mode), modeKeyboard(state));
  });

  bot.action(/^md:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    try {
      climate.setMode(id);
    } catch (err) {
      await ctx.answerCbQuery(err.message.slice(0, 190), { show_alert: true });
      return;
    }
    log(`Mode switched to ${id} by chat ${ctx.chat.id}`);
    await ctx.answerCbQuery(`Фаза: ${MODE_LABELS[id] || id}`);
    const state = climate.getState();
    await showCard(ctx, formatModes(state.profiles, state.mode), modeKeyboard(state));
  });

  bot.action('rl', async (ctx) => {
    await ctx.answerCbQuery();
    await showCard(ctx, relayCard(), relayKeyboard(climate.getState()));
  });

  bot.action(/^rl:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    // Reject 0, 7, 8, 9, ... before the controller is touched at all
    if (!Number.isInteger(id) || id < 1 || id > RELAY_NAMES.length) {
      await ctx.answerCbQuery(`Недопустимый номер реле: ${ctx.match[1]}`, { show_alert: true });
      return;
    }

    const state = climate.getState();
    const next = !state.relays[id - 1];
    const result = applyRelayCommand(id, next, `telegram button (chat ${ctx.chat.id})`);

    if (!result.ok) {
      log(`Relay ${id} ON refused: ${result.error}`);
      await ctx.answerCbQuery(`⛔ ${result.error}`.slice(0, 190), { show_alert: true });
      await showCard(ctx, relayCard(), relayKeyboard(climate.getState()));
      return;
    }

    const manual = state.mode === 'manual';
    await ctx.answerCbQuery(
      `${RELAY_NAMES[id - 1]}: ${next ? 'ВКЛ' : 'ВЫКЛ'}${manual || !next ? '' : ' · автоматика может вернуть состояние'}`,
      { show_alert: false }
    );
    await showCard(ctx, relayCard(), relayKeyboard(climate.getState()));
  });

  bot.action('ph', async (ctx) => {
    await ctx.answerCbQuery('📷 Снимаю…');
    await captureAndSend(ctx);
  });

  bot.action('gal', async (ctx) => {
    await ctx.answerCbQuery('📁 Последние кадры');
    await sendGallery(ctx, 3);
  });

  bot.action(/^stats:(\d+)$/, async (ctx) => {
    const hours = Math.min(Math.max(Number(ctx.match[1]), 1), 168);
    if (!queryHistory) {
      await ctx.answerCbQuery('История недоступна: InfluxDB не подключена', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery(`Запрос за ${hours} ч…`);
    try {
      const summary = await queryHistory(hours);
      await showCard(ctx, formatStats(hours, summary), statsKeyboard(hours));
    } catch (err) {
      await ctx.answerCbQuery(`Ошибка InfluxDB: ${err.message}`.slice(0, 190), { show_alert: true });
    }
  });

  bot.action('nt', async (ctx) => {
    alertsEnabled = !alertsEnabled;
    log(`Alerts ${alertsEnabled ? 'enabled' : 'disabled'} by chat ${ctx.chat.id} (button)`);
    await ctx.answerCbQuery(alertsEnabled ? '🔔 Уведомления об авариях включены' : '🔕 Уведомления об авариях выключены');
    await showKeyboard(ctx, mainMenu());
  });

  bot.action('ap', async (ctx) => {
    const order = ['off', 'on', '60'];
    const current = !auto.enabled ? 'off' : (auto.minIntervalMs === 0 ? 'on' : '60');
    const next = order[(order.indexOf(current) + 1) % order.length];
    auto = parseAutoPhoto(next);
    lastAutoSentAt = 0;
    log(`Auto photo ${auto.enabled ? auto.label : 'disabled'} by chat ${ctx.chat.id} (button)`);
    await ctx.answerCbQuery(`📷 Автофото: ${auto.enabled ? auto.short : 'выкл'}`);
    await showKeyboard(ctx, mainMenu());
  });

  // -- alarm push -----------------------------------------------------------
  async function broadcast(text, keyboard) {
    const targets = allowed.length ? allowed : [];
    const options = { parse_mode: 'HTML' };
    if (keyboard) options.reply_markup = { inline_keyboard: keyboard };
    for (const chatId of targets) {
      try {
        await bot.telegram.sendMessage(chatId, text, options);
      } catch (err) {
        log(`Cannot deliver alert to ${chatId}: ${err.message}`);
      }
    }
  }

  async function checkAlerts() {
    const state = climate.getState();
    // Before the first telemetry packet the controller reports a bogus SENSOR_FAIL
    // (temperature is still unknown) - never push that as an emergency.
    if (!state.lastSensors?.updated_at) return;
    const alert = state.safetyAlert || null;
    if (alert === lastAlert) return;
    const previous = lastAlert;
    lastAlert = alert; // always track the transition, even while notifications are off

    // Suppression covers BOTH directions: switching /notify off must silence the
    // "raised" push and the "cleared" push. Because lastAlert is still updated,
    // re-enabling later never replays stale transitions.
    if (!alertsEnabled) return;

    if (!alert) {
      if (previous) {
        log(`Alarm cleared (${previous})`);
        await broadcast(
          `✅ <b>Авария устранена</b> (${esc(ALARM_TEXT[previous] || previous)})\n🕒 ${fmtTime()}\n${fmtSensorsLine(state.lastSensors)}`,
          alarmKeyboard()
        );
      }
      return;
    }

    log(`Alarm raised: ${alert}`);
    await broadcast([
      `🚨 <b>АВАРИЯ: ${esc(ALARM_TEXT[alert] || alert)}</b>`,
      `🕒 <b>${fmtTime()}</b>`,
      fmtSensorsLine(state.lastSensors),
      `🧠 ${esc(state.modeName)} • ${esc(state.substate)}`,
      state.relays?.map((on, i) => `${i + 1}${on ? '🟢' : '⚪'}`).join(' ')
    ].join('\n'), alarmKeyboard());
  }

  const alertTimer = setInterval(() => { checkAlerts().catch((e) => log(`alert check: ${e.message}`)); }, ALERT_POLL_MS);

  // -- lifecycle ------------------------------------------------------------
  // Any error raised inside a handler is logged here instead of escaping and
  // taking the bridge process down.
  bot.catch((err, ctx) => {
    const where = ctx?.updateType || 'update';
    log(`Handler error (${where}): ${err?.message || err}`);
  });

  // bot.launch() resolves only when polling stops, so readiness is signalled by
  // telegraf's onLaunch callback instead of awaiting the returned promise.
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  function launchPolling() {
    if (stopping) return;
    const options = firstLaunch ? launchOptions : { ...launchOptions, dropPendingUpdates: false };
    firstLaunch = false;
    Promise.resolve().then(() => bot.launch(options, () => {
      log(`Bot started (polling), authorised chats: ${allowed.length ? allowed.join(', ') : 'none configured'}`);
      markReady(true);
    })).catch((err) => {
      log(`Polling stopped: ${err.message}`);
      markReady(false);
    }).finally(() => {
      if (!stopping) {
        retryTimer = setTimeout(launchPolling, Math.max(50, retryDelayMs));
        retryTimer.unref?.();
      }
    });
  }
  launchPolling();

  return {
    bot,
    ready,
    /** Called by the bridge after a fresh ESP32 frame has been saved to disk. */
    onImageSaved(filename) {
      try {
        if (pendingCapture) {
          // A /photo request is waiting for this frame - it is delivered by that flow.
          // Mark it as forwarded first so auto-photo cannot send it twice.
          forwarded.add(filename);
          pendingCapture.resolve(filename);
          return;
        }
        forwardAutoPhoto(filename).catch((err) => log(`auto photo failed: ${err.message}`));
      } catch (err) {
        log(`onImageSaved failed for ${filename}: ${err.message}`);
      }
    },
    checkAlerts,
    /** True while a /photo request is waiting for a frame from the ESP32. */
    hasPendingCapture: () => Boolean(pendingCapture),
    async stop() {
      stopping = true;
      clearTimeout(retryTimer);
      clearInterval(alertTimer);
      // Release a waiting /photo so the handler does not hang after shutdown.
      abortPendingCapture();
      try {
        bot.stop();
      } catch (err) {
        log(`stop failed: ${err.message}`);
      }
    }
  };
}

module.exports = {
  createTelegramBot,
  formatStatus,
  formatCaption,
  formatStats,
  formatModes,
  fmtTime,
  esc,
  RELAY_NAMES
};
