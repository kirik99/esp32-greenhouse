const crypto = require('node:crypto');

const TOPIC_PREFIX = 'growbox/diagnostics/';
const DEVICE = /^GrowboxESP32_[A-F0-9]{12}$/;
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

function redact(message, secrets = []) {
  let text = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
  // Do not echo command payloads, credentials or PEM fragments, even in downloads.
  if (/\[MQTT MSG\].*->|(?:password|passwd|authorization|secret|token|private.?key|signature)\s*[=:]|-----.*KEY-----/i.test(text)) return '[sensitive diagnostic omitted]';
  for (const secret of secrets) if (secret && text.includes(secret)) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:https?|mqtts?|wss?):\/\/\S+/gi, '[URL omitted]')
    .replace(/\b[A-Za-z0-9_+\/=-]{40,}\b/g, '[opaque value omitted]').slice(0, 240);
}

class DeviceDiagnostics {
  constructor({ now = Date.now, secrets = [], capacity = 500 } = {}) {
    this.now = now; this.secrets = secrets; this.capacity = capacity;
    this.epoch = crypto.randomBytes(12).toString('hex');
    this.rows = []; this.nextId = 1; this.seen = new Set(); this.devices = new Map();
    this.window = now(); this.accepted = 0; this.rejected = 0;
  }

  observeStatus(status) {
    const id = status?.camera_config?.device_id;
    if (!DEVICE.test(id || '')) return;
    this.devices.delete(id);
    this.devices.set(id, { id, supported: status.diagnostics?.protocol === 1 && status.diagnostics?.enabled === true, seen_at: this.now() });
    while (this.devices.size > 4) this.devices.delete(this.devices.keys().next().value);
  }

  ingest(topic, payload, packet = {}) {
    if (!topic.startsWith(TOPIC_PREFIX)) return false;
    const refuse = () => { this.rejected++; return false; };
    if (packet.retain || !Buffer.isBuffer(payload) || payload.length > 1024) return refuse();
    // Fixed global budget; arbitrary device IDs cannot create unbounded rate-limit maps.
    const now = this.now();
    if (now - this.window >= 1000) { this.window = now; this.accepted = 0; }
    if (this.accepted >= 10) return refuse();
    this.accepted++;
    let d;
    try { d = JSON.parse(payload.toString('utf8')); } catch (_) { return refuse(); }
    if (!d || typeof d !== 'object' || Array.isArray(d) || d.protocol !== 1 ||
      !DEVICE.test(d.device_id || '') || topic !== TOPIC_PREFIX + d.device_id ||
      !/^[a-f0-9]{8}$/.test(d.boot_id || '') || !uint32(d.seq) || d.seq === 0 ||
      !uint32(d.uptime_ms) || !uint32(d.dropped) || !['INFO', 'WARN', 'ERROR'].includes(d.level) ||
      typeof d.message !== 'string' || !d.message.trim() || Buffer.byteLength(d.message) > 240) return refuse();
    const key = `${d.device_id}/${d.boot_id}/${d.seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    while (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value);
    this.rows.push({ id: this.nextId++, received_at: new Date(now).toISOString(), device_id: d.device_id,
      boot_id: d.boot_id, seq: d.seq, uptime_ms: d.uptime_ms, dropped: d.dropped, level: d.level,
      message: redact(d.message, this.secrets) });
    if (this.rows.length > this.capacity) this.rows.shift();
    return true;
  }

  snapshot({ after = 0, epoch = '' } = {}) {
    const oldest = this.rows[0]?.id || this.nextId;
    const reset = !!epoch && (epoch !== this.epoch || after < oldest - 1 || after >= this.nextId);
    const rows = this.rows.filter(row => reset || row.id > after);
    return { protocol: 1, epoch: this.epoch, cursor: this.nextId - 1, reset, capacity: this.capacity,
      rejected_packets: this.rejected, devices: [...this.devices.values()].map(d => ({ ...d, fresh: this.now() - d.seen_at < 120000 })), rows };
  }
}

function installDiagnostics(app, { store, requireAuth, mqttConnected = () => false }) {
  if (typeof requireAuth !== 'function') throw Error('Diagnostics requires PIN authentication');
  app.get('/api/diagnostics', requireAuth, (req, res) => {
    const { after = '0', epoch = '' } = req.query;
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (Object.keys(req.query).some(k => !['after', 'epoch'].includes(k)) ||
      typeof after !== 'string' || !/^\d{1,15}$/.test(after) || !Number.isSafeInteger(Number(after)) ||
      typeof epoch !== 'string' || (epoch && !/^[a-f0-9]{24}$/.test(epoch))) return res.status(400).json({ error: 'Неверный курсор лога' });
    res.json({ ...store.snapshot({ after: Number(after), epoch }), mqtt_connected: mqttConnected() });
  });
  app.get('/api/diagnostics/download', requireAuth, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.attachment('growbox-esp-diagnostics.txt').type('text/plain; charset=utf-8');
    const data = store.snapshot();
    res.send('ESP application log; server receipt time (UTC), not camera shutter time. RAM history only.\n' +
      data.rows.map(r => `${r.received_at} ${r.device_id} boot=${r.boot_id} seq=${r.seq} uptime_ms=${r.uptime_ms} dropped=${r.dropped} ${r.level} ${r.message}`).join('\n') + '\n');
  });
}

module.exports = { DeviceDiagnostics, installDiagnostics, TOPIC_PREFIX, redact };
