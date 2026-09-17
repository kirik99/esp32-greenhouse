require('dotenv').config();
const mqtt = require('mqtt');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { ClimateController } = require('./automation');

// Configuration
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
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

// MQTT Setup
const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`);

// Climate Controller State Machine
const climate = new ClimateController(mqttClient);

mqttClient.on('connect', () => {
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

mqttClient.on('message', async (topic, message) => {
  try {
    if (topic === 'growbox/sensors') {
      const data = JSON.parse(message.toString());
      const point = new Point('sensor_data');
      if (data.air_temp       !== undefined) point.floatField('air_temp',       data.air_temp);
      if (data.humidity       !== undefined) point.floatField('humidity',        data.humidity);
      if (data.pressure       !== undefined) point.floatField('pressure',        data.pressure);
      if (data.substrate_temp !== undefined) point.floatField('substrate_temp',  data.substrate_temp);
      if (data.co2_ppm        !== undefined) point.intField('co2_ppm',           data.co2_ppm);
      
      writeApi.writePoint(point);
      console.log(`[${new Date().toISOString()}] Sensor data written to InfluxDB:`, data);
      
      // Feed to intelligent climate controller
      climate.processSensors(data);
    } 
    else if (topic === 'growbox/status') {
      const data = JSON.parse(message.toString());
      const point = new Point('relay_status');
      // data.relays = [false, false, false, false, false, false]
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
      console.log(`[${new Date().toISOString()}] Received raw image data, size: ${message.length} bytes`);
      
      let base64Str = message.toString();
      let width = 160;
      let height = 120;

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

      const yuy2Buffer = Buffer.from(base64Str, 'base64');
      
      if (yuy2Buffer.length !== width * height * 2) {
        console.error(`[${new Date().toISOString()}] Invalid YUY2 buffer length: expected ${width * height * 2}, got ${yuy2Buffer.length}`);
        return;
      }
      
      const rgbaBuffer = yuy2ToRgba(yuy2Buffer, width, height);
      
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
      
      const jpegData = jpeg.encode({
        data: rgbaBuffer,
        width: width,
        height: height
      }, 85);
      
      fs.writeFileSync(filepath, jpegData.data);
      console.log(`[${new Date().toISOString()}] Image saved to ${filepath}`);

      const photoPoint = new Point('camera_capture')
        .stringField('filename', filename)
        .intField('size_bytes', jpegData.data.length)
        .intField('width', width)
        .intField('height', height);
      writeApi.writePoint(photoPoint);
      console.log(`[${new Date().toISOString()}] Camera capture recorded in InfluxDB: ${filename}`);
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
app.use(cors()); // Разрешаем CORS для локальной разработки
app.use(express.json());

// PIN Authentication & Session Management
const ADMIN_PIN = process.env.ADMIN_PIN || '2212';
const activeSessions = new Set();

app.post('/api/auth/verify', (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ success: false, error: 'PIN is required' });
  }
  if (String(pin).trim() === String(ADMIN_PIN).trim()) {
    const token = Buffer.from(`${Date.now()}_${Math.random()}`).toString('base64');
    activeSessions.add(token);
    setTimeout(() => activeSessions.delete(token), 3600000); // 1 hour token lifetime
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, error: 'Invalid PIN' });
});

// Climate Controller REST API
app.get('/api/climate', (req, res) => {
  res.json(climate.getState());
});

app.post('/api/climate/mode', (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode) return res.status(400).json({ error: 'Missing mode parameter' });
    const state = climate.setMode(mode);
    res.json({ success: true, state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/climate/setpoints', (req, res) => {
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

// Ручка для принудительного снимка с камеры
app.all('/api/capture', (req, res) => {
  mqttClient.publish('growbox/camera/capture', '1');
  console.log(`[${new Date().toISOString()}] Triggered on-demand camera capture via /api/capture`);
  res.json({ status: 'capture_triggered' });
});

app.get('/api/images', (req, res) => {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error reading images directory:`, err);
      return res.status(500).json({ error: 'Failed to read images directory' });
    }
    const images = files.filter(f => f.endsWith('.jpg') || f.endsWith('.png')).sort().reverse();
    res.json(images);
  });
});

app.get('/api/images/:filename', (req, res) => {
  const filepath = path.join(IMAGES_DIR, req.params.filename);
  if (fs.existsSync(filepath)) {
    res.sendFile(path.resolve(filepath));
  } else {
    res.status(404).json({ error: 'Image not found' });
  }
});

app.get('/api/latest-image', (req, res) => {
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

app.listen(BRIDGE_PORT, () => {
  console.log(`[${new Date().toISOString()}] Bridge service listening on port ${BRIDGE_PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(`[${new Date().toISOString()}] Shutting down...`);
  try {
    await writeApi.close();
    console.log(`[${new Date().toISOString()}] InfluxDB write API closed`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error closing InfluxDB write API:`, err);
  }
  mqttClient.end();
  process.exit(0);
});
