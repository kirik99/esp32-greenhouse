const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const { sign } = require('./ota-sign');

function installFirmwareDownload(app, { directory, token = '', requireAuth = null, ota = null, privateKey = '', baseUrl = '' }) {
  app.get('/api/ota/firmware/:filename', (req, res) => {
    if (!directory || token.length < 32) return res.status(503).json({ error: 'Firmware hosting disabled' });
    const actual = Buffer.from(req.get('X-OTA-Token') || ''), expected = Buffer.from(token);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'Unauthorized' });
    if (!/^[a-f0-9]{64}\.bin$/.test(req.params.filename)) return res.status(400).json({ error: 'Expected SHA-256.bin filename' });
    const file = path.resolve(directory, req.params.filename);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size < 1024 || stat.size > 0x600000) return res.status(404).end();
    } catch (_) { return res.status(404).end(); }
    res.set('Cache-Control', 'no-store');
    res.type('application/octet-stream').sendFile(file);
  });

  const raw = express.raw({ type: 'application/octet-stream', limit: 0x600000 });
  const authMiddleware = typeof requireAuth === 'function' ? requireAuth : (req, res, next) => next();

  app.post('/api/ota/upload-firmware', authMiddleware, (req, res, next) => {
    if (!directory) return res.status(503).json({ error: 'Firmware hosting disabled' });
    next();
  }, raw, async (req, res) => {
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length < 1024 || data.length > 0x600000 || data[0] !== 0xe9) {
      return res.status(400).json({ error: 'Expected valid ESP application .bin' });
    }
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const filename = `${sha256}.bin`;
    const targetPath = path.resolve(directory, filename);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(targetPath, data);
    } catch (err) {
      return res.status(500).json({ error: 'Could not save firmware file: ' + err.message });
    }

    // Auto-signing if privateKey is configured
    let manifest = null;
    let autoSigned = false;
    let signError = null;

    if (privateKey) {
      try {
        const identities = [...new Set(data.toString('latin1').match(/GROWBOX_OTA_V1:hzad-s3-n16r8:[0-9]+:/g) || [])];
        if (identities.length !== 1) {
          throw new Error('Firmware binary missing valid GROWBOX_OTA_V1 identity marker');
        }
        const buildMatch = identities[0].match(/:([0-9]+):$/);
        const build = buildMatch ? Number(buildMatch[1]) : 0;
        const deviceState = ota ? ota.getState() : null;
        const deviceId = deviceState?.device?.device_id;
        if (!deviceId) {
          throw new Error('ESP32 device ID unknown (ESP must be online to auto-sign)');
        }
        const effectiveBaseUrl = baseUrl || `${req.protocol}://${req.get('host')}/api/ota/firmware/`;
        const firmwareUrl = effectiveBaseUrl.endsWith('/') ? `${effectiveBaseUrl}${filename}` : `${effectiveBaseUrl}/${filename}`;
        const expires = Math.floor(Date.now() / 1000) + 86400; // 24 hours

        // Create temporary key file if privateKey is PEM string
        const tmpKeyPath = path.join(directory, `.tmp_sign_key_${Date.now()}.pem`);
        fs.writeFileSync(tmpKeyPath, privateKey, { mode: 0o600 });
        try {
          manifest = sign({
            binary: targetPath,
            key: tmpKeyPath,
            device: deviceId,
            url: firmwareUrl,
            build,
            expires
          });
          autoSigned = true;
        } finally {
          try { fs.unlinkSync(tmpKeyPath); } catch (_) {}
        }
      } catch (err) {
        signError = err.message;
      }
    }

    return res.status(201).json({
      filename,
      sha256,
      size: data.length,
      auto_signed: autoSigned,
      manifest,
      sign_error: signError
    });
  });
}
module.exports = { installFirmwareDownload };
