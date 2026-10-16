const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SET_TOPIC = 'growbox/camera/config/set';
const STATE_TOPIC = 'growbox/camera/config/state';
const validInterval = n => Number.isInteger(n) && n >= 60 && n <= 86400 && n % 60 === 0;
const validId = s => typeof s === 'string' && /^[a-f0-9-]{36}$/.test(s);

class CameraSettings {
  constructor({ mqttClient, stateFile, now = Date.now, logger = console }) {
    this.mqtt = mqttClient;
    this.stateFile = stateFile;
    this.now = now;
    this.logger = logger;
    // New installations and unreadable state fail closed. No startup snapshot.
    this.settings = { reception_enabled: false, auto_enabled: false, interval_seconds: 600, request_id: crypto.randomUUID() };
    this.device = null;
    this.loadError = false;
    try {
      if (fs.existsSync(stateFile)) {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        this.validate(saved, true);
        this.settings = saved;
      }
    } catch (_) {
      this.loadError = true;
      logger.error('[Camera] Invalid saved settings; reception and auto capture disabled');
    }
  }

  validate(value, saved = false) {
    const keys = ['reception_enabled', 'auto_enabled', 'interval_seconds', ...(saved ? ['request_id'] : [])];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) ||
        typeof value.reception_enabled !== 'boolean' || typeof value.auto_enabled !== 'boolean' || !validInterval(value.interval_seconds) ||
        (saved && !validId(value.request_id))) throw new Error('Ожидаются два переключателя и целый интервал 1–1440 минут');
    if (!value.reception_enabled && value.auto_enabled) throw new Error('Для автосъёмки сначала разрешите приём фото');
  }

  update(input) {
    this.validate(input);
    const next = { ...input, request_id: crypto.randomUUID() };
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.stateFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.stateFile);
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    this.settings = next; // Only change live policy after a successful save.
    this.loadError = false;
    this.publish();
    return this.getState();
  }

  publish() {
    if (!this.mqtt?.connected) return false;
    const { auto_enabled, interval_seconds, request_id } = this.settings;
    try {
      this.mqtt.publish(SET_TOPIC, JSON.stringify({ protocol: 1, auto_enabled, interval_seconds, request_id }),
        { qos: 1, retain: true }, err => { if (err) this.logger.error('[Camera] Settings publish failed'); });
      return true;
    } catch (_) {
      this.logger.error('[Camera] Settings saved but MQTT delivery failed');
      return false;
    }
  }

  observeState(value) {
    if (!value || value.protocol !== 1 || typeof value.auto_enabled !== 'boolean' ||
        !validInterval(value.interval_seconds) || (value.request_id !== '' && !validId(value.request_id)) ||
        typeof value.persisted !== 'boolean' || typeof value.camera_ready !== 'boolean' || typeof value.device_id !== 'string' || value.device_id.length > 64) return false;
    this.device = { ...value, supported: true, updated_at: this.now() };
    return true;
  }

  observeStatus(status) {
    if (status.camera_config) return this.observeState(status.camera_config);
    this.device = { supported: false, updated_at: this.now() };
    return false;
  }

  getState() {
    const s = this.settings;
    const d = this.device;
    const fresh = !!d && this.now() - d.updated_at < 120000;
    return { settings: { ...s }, load_error: this.loadError, mqtt_connected: !!this.mqtt?.connected,
      device: d ? { ...d, fresh, confirmed: fresh && d.supported && d.persisted && d.request_id === s.request_id &&
        d.auto_enabled === s.auto_enabled && d.interval_seconds === s.interval_seconds } : null };
  }

  acceptsPhotos() { return this.settings.reception_enabled; }
}

module.exports = { CameraSettings, SET_TOPIC, STATE_TOPIC };
