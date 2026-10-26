require('dotenv').config();
const mqtt = require('mqtt');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jpeg = require('jpeg-js');
const { ClimateController, isValidReading } = require('./automation');
const { buildImageMetadata, writeImageMetadata } = require('./image-metadata');
// Optional bot failures must not prevent the bridge from serving telemetry/photos.
let createTelegramBot = null;
try { ({ createTelegramBot } = require('./telegram')); }
catch (err) { console.error('[Telegram] Module unavailable; bot disabled:', err.message); }
const { installImageUpload } = require('./image-upload');
const { CameraSettings, STATE_TOPIC: CAMERA_STATE_TOPIC } = require('./camera-settings');

// Configuration
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const MQTT_USER = process.env.MQTT_USER || 'growbox_bridge';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || 'growbox_bridge_secret';
const MQTT_WEB_USER = process.env.MQTT_WEB_USER || 'growbox_web';
const MQTT_WEB_PASSWORD = process.env.MQTT_WEB_PASSWORD || 'growbox_web_secret';
const PUBLIC_TELEMETRY = process.env.PUBLIC_TELEMETRY === 'true';
const INFLUXDB_URL = process.env.INFLUXDB_URL || 'http://localhost:8086';
const INFLUXDB_TOKEN = process.env.INFLUXDB_TOKEN || 'growbox-super-secret-token';
const INFLUXDB_ORG = process.env.INFLUXDB_ORG || 'growbox';
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'sensors';
const BRIDGE_PORT = process.env.BRIDGE_PORT || 3001;
const IMAGES_DIR = process.env.IMAGES_DIR || './images';

// Ensure images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// InfluxDB Setup
const influxDB = new InfluxDB({ url: INFLUXDB_URL, token: INFLUXDB_TOKEN });
const writeApi = influxDB.getWriteApi(INFLUXDB_ORG, INFLUXDB_BUCKET);
writeApi.useDefaultTags({ location: 'growbox' });

// MQTT Setup with Authentication
const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  queueQoSZero: false, // Never queue stale control/OTA commands across disconnects.
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  clientId: `growbox_bridge_${Math.random().toString(16).slice(2, 8)}`
});

// Climate Controller State Machine
const climate = new ClimateController(mqttClient);
const cameraSettings = new CameraSettings({ mqttClient,
  stateFile: process.env.CAMERA_SETTINGS_FILE || path.join(path.dirname(process.env.CLIMATE_STATE_FILE || path.join(__dirname, 'climate_state.json')), 'camera_settings.json')
});
const { OtaController } = require('./ota');
const ota = new OtaController({ mqtt:mqttClient, climate, publicKey:process.env.OTA_SIGNING_PUBLIC_KEY || '' });

// Historical aggregate query used by the Telegram /stats command
const queryApi = influxDB.getQueryApi(INFLUXDB_ORG);
const HISTORY_FIELDS = [
  { field: 'air_temp', label: '🌡 Воздух', unit: '°C', digits: 1 },
  { field: 'humidity', label: '💧 Влажность', unit: '%', digits: 0 },
  { field: 'substrate_temp', label: '🌱 Субстрат', unit: '°C', digits: 1 },
  { field: 'co2_ppm', label: '🫧 CO₂', unit: 'ppm', digits: 0 }
];

async function queryHistory(hours) {
  const fieldFilter = HISTORY_FIELDS.map(f => `r._field == "${f.field}"`).join(' or ');
  const flux = `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -${hours}h)
  |> filter(fn: (r) => r._measurement == "sensor_data")
  |> filter(fn: (r) => ${fieldFilter})
  |> keep(columns: ["_time", "_field", "_value"])`;

  const rows = await queryApi.collectRows(flux);

  return HISTORY_FIELDS.map((f) => {
    const values = rows
      .filter(r => r._field === f.field)
      .map(r => Number(r._value))
      .filter(isValidReading);
    if (!values.length) return null;
    return {
      label: f.label,
      unit: f.unit,
      digits: f.digits,
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length
    };
  }).filter(Boolean);
}

// Telegram bot: token and chat allowlist come from the environment (.env -> compose),
// never from the repository. Without a token the bot stays disabled.
let telegram = null;
if (createTelegramBot) {
  try {
    telegram = createTelegramBot({
      climate,
      mqttClient,
      imagesDir: IMAGES_DIR,
      queryHistory,
      canCapture: () => cameraSettings.acceptsPhotos()
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [Telegram] init failed, bot disabled:`, err.message);
  }
}

mqttClient.on('connect', () => {
  mqttClient.subscribe(CAMERA_STATE_TOPIC, { qos: 1 });
  cameraSettings.publish();
  console.log(`[${new Date().toISOString()}] Connected to MQTT broker at ${MQTT_HOST}:${MQTT_PORT}`);
  mqttClient.subscribe('growbox/sensors', (err) => {
    if (!err) console.log(`[${new Date().toISOString()}] Subscribed to growbox/sensors`);
  });
  mqttClient.subscribe('growbox/status', (err) => {
    if (!err) console.log(`[${new Date().toISOString()}] Subscribed to growbox/status`);
  });
  mqttClient.subscribe('growbox/image/raw', (err) => {
    if (!err) console.log(`[${new Date().toISOString()}] Subscribed to growbox/image/raw`);
  });
});

mqttClient.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] MQTT Connection Error:`, err.message);
});

// Helper for YUY2 to RGBA conversion
function yuy2ToRgba(yuy2Buffer, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < yuy2Buffer.length; i += 4, j += 8) {
    const y0 = yuy2Buffer[i];
    const u = yuy2Buffer[i + 1];
    const y1 = yuy2Buffer[i + 2];
    const v = yuy2Buffer[i + 3];
    
    const c0 = y0 - 16, c1 = y1 - 16;
    const d = u - 128, e = v - 128;
    
    rgba[j]   = Math.max(0, Math.min(255, (298 * c0 + 409 * e + 128) >> 8));
    rgba[j+1] = Math.max(0, Math.min(255, (298 * c0 - 100 * d - 208 * e + 128) >> 8));
    rgba[j+2] = Math.max(0, Math.min(255, (298 * c0 + 516 * d + 128) >> 8));
    rgba[j+3] = 255;
    
    rgba[j+4] = Math.max(0, Math.min(255, (298 * c1 + 409 * e + 128) >> 8));
    rgba[j+5] = Math.max(0, Math.min(255, (298 * c1 - 100 * d - 208 * e + 128) >> 8));
    rgba[j+6] = Math.max(0, Math.min(255, (298 * c1 + 516 * d + 128) >> 8));
    rgba[j+7] = 255;
  }
  return rgba;
}

function saveImageBuffer(imgBuffer, width = 1280, height = 720) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const filename = `${y}-${m}-${d}_${hh}-${mm}-${ss}.jpg`;
  const filepath = path.join(IMAGES_DIR, filename);
  let savedSize = imgBuffer.length;

  if (imgBuffer.length > 4 && imgBuffer[0] === 0xFF && imgBuffer[1] === 0xD8) {
    // Native JPEG from hardware camera (OV2640 / esp_camera)
    fs.writeFileSync(filepath, imgBuffer);
    console.log(`[${new Date().toISOString()}] Native JPEG saved to ${filepath} (${imgBuffer.length} bytes, ${width}x${height})`);
  } else {
    // Legacy YUY2 raw buffer conversion
    if (imgBuffer.length !== width * height * 2) {
      console.error(`[${new Date().toISOString()}] Invalid image buffer: expected JPEG (0xFF 0xD8) or YUY2 length ${width * height * 2}, got ${imgBuffer.length}`);
      return { success: false, error: 'Invalid buffer format/length' };
    }
    
    const rgbaBuffer = yuy2ToRgba(imgBuffer, width, height);
    const jpegData = jpeg.encode({
      data: rgbaBuffer,
      width: width,
      height: height
    }, 85);
    
    fs.writeFileSync(filepath, jpegData.data);
    savedSize = jpegData.data.length;
    console.log(`[${new Date().toISOString()}] YUY2 converted to JPEG and saved to ${filepath}`);
  }

  writeImageMetadata(filepath, buildImageMetadata(climate.getState(), {
    receivedAt: now, width, height, sizeBytes: savedSize
  }));
  if (telegram) telegram.onImageSaved(filename);
  const photoPoint = new Point('camera_capture')
    .stringField('filename', filename)
    .intField('size_bytes', savedSize)
    .intField('width', width)
    .intField('height', height);
  writeApi.writePoint(photoPoint);
  console.log(`[${new Date().toISOString()}] Camera capture recorded in InfluxDB: ${filename}`);

  return { success: true, filename, filepath, size: imgBuffer.length };
}

mqttClient.on('message', async (topic, message) => {
  try {
    if (topic === CAMERA_STATE_TOPIC) {
      cameraSettings.observeState(JSON.parse(message.toString()));
      return;
    }
    if (topic === 'growbox/sensors') {
      const data = JSON.parse(message.toString());
      const point = new Point('sensor_data');

      const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v !== -999;
      const channels = [
        ['air_temp', 'air_temp_ok', 'float'],
        ['humidity', 'humidity_ok', 'float'],
        ['pressure', 'pressure_ok', 'float'],
        ['substrate_temp', 'substrate_temp_ok', 'float'],
        ['co2_ppm', 'co2_ok', 'int']
      ];

      const offline = [];
      let online = 0;

      for (const [field, flag, kind] of channels) {
        const value = data[field];
        const ok = (data[flag] === undefined) ? valid(value) : (data[flag] === true && valid(value));
        if (ok) {
          if (kind === 'int') {
            point.intField(field, Math.round(value));
          } else {
            point.floatField(field, value);
          }
          online++;
        } else {
          offline.push(field);
        }
      }

      point.intField('sensors_online', online);
      point.intField('sensors_total', channels.length);
      if (data.i2c_devices) point.stringField('i2c_devices', String(data.i2c_devices));
      if (data.diag) point.stringField('diag', String(data.diag).slice(0, 512));

      writeApi.writePoint(point);

      if (offline.length) {
        console.warn(`[${new Date().toISOString()}] Sensor channels offline (${offline.join(', ')}). diag: ${data.diag || 'n/a'}`);
      } else {
        console.log(`[${new Date().toISOString()}] Sensor data written to InfluxDB:`, data);
      }

      // Feed to intelligent climate controller
      climate.processSensors(data);
    } 
    else if (topic === 'growbox/status') {
      const data = JSON.parse(message.toString());
      cameraSettings.observeStatus(data);
      ota.observe(data);
      const point = new Point('relay_status');
      if (Array.isArray(data.relays)) {
        const names = ['humidifier','heater','heater_fan','fan1','fan2','backlight'];
        data.relays.forEach((state, i) => {
          point.booleanField(names[i], state);
        });
      }
      if (data.uptime_s  !== undefined) point.intField('uptime_s',  data.uptime_s);
      if (data.wifi_rssi !== undefined) point.intField('wifi_rssi', data.wifi_rssi);
      if (data.free_heap !== undefined) point.intField('free_heap', data.free_heap);
      
      writeApi.writePoint(point);
      console.log(`[${new Date().toISOString()}] Status data written to InfluxDB:`, data);

      // Feed to intelligent climate controller
      climate.updateHardwareStatus(data);
    }
    else if (topic === 'growbox/image/raw') {
      if (!cameraSettings.acceptsPhotos()) return;
      console.log(`[${new Date().toISOString()}] Received raw image data via MQTT, size: ${message.length} bytes`);
      
      let base64Str = message.toString();
      let width = 1280;
      let height = 720;

      if (base64Str.startsWith('{')) {
        try {
          const parsed = JSON.parse(base64Str);
          if (parsed.data) base64Str = parsed.data;
          if (parsed.width) width = parsed.width;
          if (parsed.height) height = parsed.height;
        } catch (e) {
          console.error(`[${new Date().toISOString()}] Failed to parse image JSON:`, e.message);
        }
      }

      const imgBuffer = Buffer.from(base64Str, 'base64');
      saveImageBuffer(imgBuffer, width, height);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error processing MQTT message on topic ${topic}:`, err.message);
  }
});

// Flush InfluxDB periodically to avoid memory leaks
setInterval(() => {
  writeApi.flush().catch(err => {
    console.error(`[${new Date().toISOString()}] Error flushing InfluxDB:`, err);
  });
}, 10000);

// Express App setup
const app = express();
require('./ota-download').installFirmwareDownload(app, {
  directory: process.env.OTA_ARTIFACT_DIR,
  token: process.env.OTA_DOWNLOAD_TOKEN,
  requireAuth,
  ota,
  privateKey: process.env.OTA_SIGNING_PRIVATE_KEY || '',
  baseUrl: process.env.OTA_FIRMWARE_BASE_URL || ''
});
installImageUpload(app, {
  imagesDir: IMAGES_DIR,
  token: process.env.IMAGE_UPLOAD_TOKEN,
  acceptsPhotos: () => cameraSettings.acceptsPhotos(),
  getSensors: () => ({ ...climate.lastSensors }),
  getState: () => climate.getState(),
  onSaved: ({ filename, width, height, size }) => {
    // Resolve /photo and forward auto photos only after JPEG + sidecar are saved.
    if (telegram) telegram.onImageSaved(filename);
    writeApi.writePoint(new Point('camera_capture').stringField('filename', filename)
      .intField('size_bytes', size).intField('width', width).intField('height', height));
    mqttClient.publish('growbox/camera/updated', JSON.stringify({ filename }), { qos: 1 });
    console.log(`[UPLOAD] JPEG saved: ${filename} (${size} bytes, ${width}x${height})`);
  }
});
app.use(cors()); // Разрешаем CORS для локальной разработки

app.use(express.json());

// PIN Authentication, Brute-force Protection & Session Management
const ADMIN_PIN = process.env.ADMIN_PIN || '2212';
const activeSessions = new Set();
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const record = loginAttempts.get(ip);
  if (record && record.lockedUntil && Date.now() < record.lockedUntil) {
    const waitSec = Math.ceil((record.lockedUntil - Date.now()) / 1000);
    return { locked: true, waitSec };
  }
  return { locked: false };
}

function recordFailedLogin(ip) {
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 min lock
    record.count = 0;
  }
  loginAttempts.set(ip, record);
}

function recordSuccessfulLogin(ip) {
  loginAttempts.delete(ip);
}

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a).trim());
  const bufB = Buffer.from(String(b).trim());
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/auth/verify', (req, res) => {
  const ip = getClientIp(req);
  const { locked, waitSec } = checkRateLimit(ip);
  if (locked) {
    return res.status(429).json({
      success: false,
      error: `Слишком много неверных попыток ввода PIN. Доступ заблокирован на ${Math.ceil(waitSec / 60)} мин.`
    });
  }

  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ success: false, error: 'PIN is required' });
  }

  if (timingSafeCompare(pin, ADMIN_PIN)) {
    recordSuccessfulLogin(ip);
    const token = Buffer.from(`${Date.now()}_${Math.random()}`).toString('base64');
    activeSessions.add(token);
    setTimeout(() => activeSessions.delete(token), 3600000); // 1 hour token lifetime
    return res.json({
      success: true,
      token,
      mqtt: {
        username: MQTT_WEB_USER,
        password: MQTT_WEB_PASSWORD
      }
    });
  }

  recordFailedLogin(ip);
  // Artificial 500ms delay to thwart rapid-fire automated brute force
  setTimeout(() => {
    const attemptsLeft = 5 - ((loginAttempts.get(ip)?.count) || 0);
    return res.status(401).json({
      success: false,
      error: attemptsLeft > 0 ? `Неверный PIN-код. Осталось попыток: ${attemptsLeft}` : 'Неверный PIN-код. Превышен лимит попыток: доступ заблокирован на 15 минут.'
    });
  }, 500);
});

// Authentication Guard Middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-session-token'];
  const queryToken = req.query ? req.query.token : null;
  const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null) || queryToken;
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized: valid PIN session token required' });
  }
  next();
}

// Telemetry & Images Access Guard
function requireTelemetryAuth(req, res, next) {
  if (PUBLIC_TELEMETRY) return next();
  return requireAuth(req, res, next);
}

// Check current session status and telemetry permissions
app.get('/api/auth/session', (req, res) => {
  const authHeader = req.headers['authorization'] || req.headers['x-session-token'];
  const queryToken = req.query ? req.query.token : null;
  const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null) || queryToken;
  const isValid = token && activeSessions.has(token);

  if (isValid) {
    return res.json({
      authenticated: true,
      public_telemetry: PUBLIC_TELEMETRY,
      mqtt: {
        username: MQTT_WEB_USER,
        password: MQTT_WEB_PASSWORD
      }
    });
  }

  if (PUBLIC_TELEMETRY) {
    return res.json({
      authenticated: false,
      public_telemetry: true,
      mqtt: {
        username: MQTT_WEB_USER,
        password: MQTT_WEB_PASSWORD
      }
    });
  }

  return res.json({
    authenticated: false,
    public_telemetry: false
  });
});

// Relay Control REST API (Requires valid PIN session)
app.get('/api/ota/status', requireAuth, (req, res) => res.json(ota.getState()));
app.post('/api/ota/start', requireAuth, async (req, res) => {
  try { res.status(202).json(await ota.start(req.body)); }
  catch (err) { res.status(409).json({error:err.message}); }
});
app.get('/api/camera/settings', requireTelemetryAuth, (req, res) => res.json(cameraSettings.getState()));
app.put('/api/camera/settings', requireAuth, (req, res) => {
  try {
    cameraSettings.validate(req.body);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    return res.json(cameraSettings.update(req.body));
  } catch (_) { return res.status(500).json({ error: 'Не удалось сохранить настройки камеры' }); }
});

app.post('/api/relay', requireAuth, (req, res) => {
  const { relay, state } = req.body;
  const result = climate.manualSetRelay(relay, state, `rest api (${getClientIp(req)})`);
  if (!result.ok) {
    console.warn(`[${new Date().toISOString()}] Relay command refused: ${result.error}`);
    return res.status(result.kind === 'invalid' ? 400 : 409).json({ success: false, error: result.error });
  }
  res.json({ success: true, relay: result.relay, state: result.state });
});

// Climate Controller REST API
app.get('/api/climate', requireTelemetryAuth, (req, res) => {
  res.json(climate.getState());
});

app.post('/api/climate/mode', requireAuth, (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode) return res.status(400).json({ error: 'Missing mode parameter' });
    const state = climate.setMode(mode);
    res.json({ success: true, state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/climate/setpoints', requireAuth, (req, res) => {
  try {
    const { mode, setpoints } = req.body;
    if (!mode || !setpoints) return res.status(400).json({ error: 'Missing mode or setpoints parameter' });
    const updated = climate.updateProfileSetpoints(mode, setpoints);
    res.json({ success: true, profile: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', climate_mode: climate.mode });
});

// Ручка для принудительного снимка с камеры (требует авторизации)
app.post('/api/capture', requireAuth, (req, res) => {
  if (!cameraSettings.acceptsPhotos()) return res.status(409).json({ error: 'Приём фото отключён в настройках камеры' });
  mqttClient.publish('growbox/camera/capture', '1');
  console.log(`[${new Date().toISOString()}] Triggered on-demand camera capture via /api/capture`);
  res.json({ status: 'capture_triggered' });
});

require('./photo-export').installPhotoExport(app, { imagesDir: IMAGES_DIR, requireAuth });

app.get('/api/images', requireTelemetryAuth, (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error reading images directory:`, err);
      return res.status(500).json({ error: 'Failed to read images directory' });
    }
    const images = files.filter(f => f.endsWith('.jpg') || f.endsWith('.png')).sort().reverse();
    res.json(images);
  });
});

app.get('/api/images/:filename', requireTelemetryAuth, (req, res) => {
  const filepath = path.join(IMAGES_DIR, req.params.filename);
  if (fs.existsSync(filepath)) {
    res.sendFile(path.resolve(filepath));
  } else {
    res.status(404).json({ error: 'Image not found' });
  }
});

app.get('/api/latest-image', requireTelemetryAuth, (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error reading images directory:`, err);
      return res.status(500).json({ error: 'Failed to read images directory' });
    }
    const images = files.filter(f => f.endsWith('.jpg') || f.endsWith('.png')).sort().reverse();
    if (images.length > 0) {
      const filepath = path.join(IMAGES_DIR, images[0]);
      res.sendFile(path.resolve(filepath));
    } else {
      res.status(404).json({ error: 'No images found' });
    }
  });
});

const httpServer = app.listen(BRIDGE_PORT, () => {
  const port = httpServer.address()?.port ?? BRIDGE_PORT;
  console.log(`[${new Date().toISOString()}] Bridge service listening on port ${port}`);
});

// Handle graceful shutdown (docker sends SIGTERM, Ctrl+C sends SIGINT)
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${new Date().toISOString()}] Shutting down (${signal})...`);

  if (telegram) {
    try {
      await telegram.stop();
      console.log(`[${new Date().toISOString()}] Telegram bot stopped`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error stopping Telegram bot:`, err.message);
    }
  }

  climate.stop();

  try {
    await writeApi.close();
    console.log(`[${new Date().toISOString()}] InfluxDB write API closed`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error closing InfluxDB write API:`, err);
  }

  try {
    mqttClient.end(true);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error closing MQTT client:`, err.message);
  }

  // Do not let a stuck socket keep the container alive after SIGTERM.
  setTimeout(() => process.exit(0), 1500).unref();
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
