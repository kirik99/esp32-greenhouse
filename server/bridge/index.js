require('dotenv').config();
const mqtt = require('mqtt');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jpeg = require('jpeg-js');
const { UniversalClimateEngine } = require('./automation');
const store = require('./store');

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

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const influxDB = new InfluxDB({ url: INFLUXDB_URL, token: INFLUXDB_TOKEN });
const writeApi = influxDB.getWriteApi(INFLUXDB_ORG, INFLUXDB_BUCKET);
writeApi.useDefaultTags({ location: 'growbox' });

const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  clientId: `growbox_bridge_${Math.random().toString(16).slice(2, 8)}`
});

const climate = new UniversalClimateEngine(mqttClient, store);

mqttClient.on('connect', () => {
  console.log(`[${new Date().toISOString()}] Connected to MQTT broker`);
  mqttClient.subscribe('growbox/sensors');
  mqttClient.subscribe('growbox/status');
  mqttClient.subscribe('growbox/image/raw');
});

function yuy2ToRgba(yuy2Buffer, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < yuy2Buffer.length; i += 4, j += 8) {
    const y0 = yuy2Buffer[i], u = yuy2Buffer[i + 1], y1 = yuy2Buffer[i + 2], v = yuy2Buffer[i + 3];
    const c0 = y0 - 16, c1 = y1 - 16, d = u - 128, e = v - 128;
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

let latestSensorsSnapshot = {};

mqttClient.on('message', async (topic, message) => {
  try {
    if (topic === 'growbox/sensors') {
      const data = JSON.parse(message.toString());
      latestSensorsSnapshot = data; // Cache for image metadata
      const point = new Point('sensor_data');
      const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v !== -999;
      const channels = [
        ['air_temp', 'air_temp_ok', 'float'],
        ['humidity', 'humidity_ok', 'float'],
        ['pressure', 'pressure_ok', 'float'],
        ['substrate_temp', 'substrate_temp_ok', 'float'],
        ['co2_ppm', 'co2_ok', 'int']
      ];
      let online = 0;
      for (const [field, flag, kind] of channels) {
        const value = data[field];
        const ok = (data[flag] === undefined) ? valid(value) : (data[flag] === true && valid(value));
        if (ok) {
          if (kind === 'int') point.intField(field, Math.round(value));
          else point.floatField(field, value);
          online++;
        }
      }
      point.intField('sensors_online', online);
      point.intField('sensors_total', channels.length);
      writeApi.writePoint(point);
      climate.processSensors(data);
    } 
    else if (topic === 'growbox/status') {
      const data = JSON.parse(message.toString());
      const point = new Point('relay_status');
      if (Array.isArray(data.relays)) {
        const names = ['humidifier','heater','heater_fan','fan1','fan2','backlight'];
        data.relays.forEach((state, i) => point.booleanField(names[i], state));
      }
      writeApi.writePoint(point);
      climate.updateHardwareStatus(data);
    }
    else if (topic === 'growbox/image/raw') {
      let base64Str = message.toString();
      let width = 160, height = 120;
      if (base64Str.startsWith('{')) {
        try {
          const parsed = JSON.parse(base64Str);
          if (parsed.data) base64Str = parsed.data;
          if (parsed.width) width = parsed.width;
          if (parsed.height) height = parsed.height;
        } catch (e) {}
      }
      const yuy2Buffer = Buffer.from(base64Str, 'base64');
      if (yuy2Buffer.length !== width * height * 2) return;
      const rgbaBuffer = yuy2ToRgba(yuy2Buffer, width, height);
      
      const filename = `${new Date().toISOString().replace(/[:\.]/g, '-')}.jpg`;
      const filepath = path.join(IMAGES_DIR, filename);
      const jpegData = jpeg.encode({ data: rgbaBuffer, width, height }, 85);
      fs.writeFileSync(filepath, jpegData.data);
      
      store.addPhoto({
        filename,
        box_id: 'box_a',
        sensors: latestSensorsSnapshot,
        actuators: {} // we could pass relays here
      });
      
      const photoPoint = new Point('camera_capture')
        .stringField('filename', filename)
        .intField('size_bytes', jpegData.data.length)
        .intField('width', width)
        .intField('height', height);
      writeApi.writePoint(photoPoint);
    }
  } catch (err) {}
});

setInterval(() => { writeApi.flush().catch(() => {}); }, 10000);

const app = express();
app.use(cors());
app.use(express.json());

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
    return { locked: true, waitSec: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
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
      error: `Слишком много попыток. Доступ заблокирован на ${Math.ceil(waitSec / 60)} мин.`
    });
  }
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ success: false, error: 'PIN required' });
  if (timingSafeCompare(pin, ADMIN_PIN)) {
    loginAttempts.delete(ip);
    const token = Buffer.from(`${Date.now()}_${Math.random()}`).toString('base64');
    activeSessions.add(token);
    setTimeout(() => activeSessions.delete(token), 3600000);
    return res.json({
      success: true,
      token,
      mqtt: { username: MQTT_WEB_USER, password: MQTT_WEB_PASSWORD }
    });
  }
  recordFailedLogin(ip);
  setTimeout(() => {
    const attemptsLeft = 5 - ((loginAttempts.get(ip)?.count) || 0);
    return res.status(401).json({
      success: false,
      error: attemptsLeft > 0
        ? `Неверный PIN-код. Осталось попыток: ${attemptsLeft}`
        : 'Превышен лимит попыток. Доступ заблокирован на 15 минут.'
    });
  }, 500);
});

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-session-token'];
  const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null) || (req.query ? req.query.token : null);
  if (!token || !activeSessions.has(token)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

function requireTelemetryAuth(req, res, next) {
  if (PUBLIC_TELEMETRY) return next();
  return requireAuth(req, res, next);
}

app.get('/api/auth/session', (req, res) => {
  const authHeader = req.headers['authorization'] || req.headers['x-session-token'];
  const queryToken = req.query ? req.query.token : null;
  const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null) || queryToken;
  const isValid = token && activeSessions.has(token);
  if (isValid) {
    return res.json({
      authenticated: true,
      public_telemetry: PUBLIC_TELEMETRY,
      mqtt: { username: MQTT_WEB_USER, password: MQTT_WEB_PASSWORD }
    });
  }
  if (PUBLIC_TELEMETRY) {
    return res.json({
      authenticated: false,
      public_telemetry: true,
      mqtt: { username: MQTT_WEB_USER, password: MQTT_WEB_PASSWORD }
    });
  }
  return res.json({ authenticated: false, public_telemetry: false });
});

// Old APIs
app.post('/api/relay', requireAuth, (req, res) => {
  const { relay, state } = req.body;
  mqttClient.publish('growbox/relay/set', JSON.stringify({ relay, state }));
  res.json({ success: true, relay, state });
});
app.get('/api/climate', requireTelemetryAuth, (req, res) => res.json(climate.getState()));
app.post('/api/climate/mode', requireAuth, (req, res) => res.json({ success: true, state: climate.setMode(req.body.mode) }));
app.post('/api/climate/setpoints', requireAuth, (req, res) => res.json({ success: true, profile: climate.updateProfileSetpoints(req.body.mode, req.body.setpoints) }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.post('/api/capture', requireAuth, (req, res) => { mqttClient.publish('growbox/camera/capture', '1'); res.json({ status: 'capture_triggered' }); });
app.get('/api/images', requireTelemetryAuth, (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read' });
    res.json(files.filter(f => f.endsWith('.jpg')).sort().reverse());
  });
});
app.get('/api/images/:filename', requireTelemetryAuth, (req, res) => res.sendFile(path.resolve(path.join(IMAGES_DIR, req.params.filename))));
app.get('/api/latest-image', requireTelemetryAuth, (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    const images = files.filter(f => f.endsWith('.jpg')).sort().reverse();
    if (images.length) res.sendFile(path.resolve(path.join(IMAGES_DIR, images[0])));
    else res.status(404).json({ error: 'Not found' });
  });
});

// New REST APIs
app.get('/api/profiles', requireTelemetryAuth, (req, res) => res.json(store.getProfiles()));
app.post('/api/profiles', requireAuth, (req, res) => res.json(store.createProfile(req.body)));
app.get('/api/profiles/:id', requireTelemetryAuth, (req, res) => res.json(store.getProfile(req.params.id)));
app.put('/api/profiles/:id', requireAuth, (req, res) => res.json(store.updateProfile(req.params.id, req.body)));
app.post('/api/profiles/:id/clone', requireAuth, (req, res) => res.json(store.cloneProfile(req.params.id, req.body)));
app.delete('/api/profiles/:id', requireAuth, (req, res) => res.json(store.deleteProfile(req.params.id)));
app.get('/api/profiles/:id/export', requireAuth, (req, res) => res.json(store.exportProfile(req.params.id)));
app.post('/api/profiles/import', requireAuth, (req, res) => res.json(store.importProfile(req.body)));

app.get('/api/boxes', requireTelemetryAuth, (req, res) => res.json(store.getBoxes()));
app.post('/api/boxes', requireAuth, (req, res) => res.json(store.createBox(req.body)));

app.get('/api/cycles', requireTelemetryAuth, (req, res) => res.json(store.getCycles(req.query)));
app.post('/api/cycles/start', requireAuth, (req, res) => res.json(store.startCycle(req.body)));
app.get('/api/cycles/:id', requireTelemetryAuth, (req, res) => res.json(store.getCycle(req.params.id)));
app.post('/api/cycles/:id/stage', requireAuth, (req, res) => res.json(store.setStage(req.params.id, req.body.stage_id)));
app.post('/api/cycles/:id/harvest', requireAuth, (req, res) => res.json(store.addHarvest(req.params.id, req.body)));
app.post('/api/cycles/:id/complete', requireAuth, (req, res) => res.json(store.completeCycle(req.params.id, req.body.status)));

app.post('/api/settings/intervals', requireAuth, (req, res) => {
  mqttClient.publish('growbox/config/set', JSON.stringify(req.body));
  res.json({ success: true });
});

app.get('/api/export/dataset', requireAuth, (req, res) => res.json(store.exportDataset()));

app.listen(BRIDGE_PORT, () => console.log(`[${new Date().toISOString()}] Bridge service listening on port ${BRIDGE_PORT}`));
process.on('SIGINT', async () => { await writeApi.close(); mqttClient.end(); process.exit(0); });
