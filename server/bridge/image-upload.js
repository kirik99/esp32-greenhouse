const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const jpeg = require('jpeg-js');
const { buildImageMetadata } = require('./image-metadata');

function installImageUpload(app, { imagesDir, token, getSensors, getState, onSaved, acceptsPhotos = () => true, maxBytes = 1024 * 1024 }) {
  const raw = express.raw({ type: 'image/jpeg', limit: maxBytes, inflate: false });
  app.post('/api/upload-image', (req, res, next) => {
    if (!acceptsPhotos()) return res.status(503).json({ error: 'Photo reception disabled' });
    if (!token || token.length < 32) return res.status(503).json({ error: 'Image upload disabled' });
    const supplied = Buffer.from(req.get('X-Upload-Token') || '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!req.is('image/jpeg')) return res.status(415).json({ error: 'Expected image/jpeg' });
    next();
  }, (req, res, next) => raw(req, res, err => {
    if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? 'Image exceeds size limit' : 'Invalid upload body' });
    next();
  }), (req, res) => {
    // Policy may have changed while the upload body was being received.
    if (!acceptsPhotos()) return res.status(503).json({ error: 'Photo reception disabled' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8 ||
        body[body.length - 2] !== 0xff || body[body.length - 1] !== 0xd9) {
      return res.status(400).json({ error: 'Invalid JPEG' });
    }
    let image;
    try {
      image = jpeg.decode(body, { maxResolutionInMP: 4, maxMemoryUsageInMB: 64, tolerantDecoding: false });
    } catch (_) { return res.status(400).json({ error: 'Invalid or oversized JPEG' }); }
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3, '0')}_${crypto.randomBytes(6).toString('hex')}.jpg`;
    const filepath = path.join(imagesDir, filename);
    try {
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(filepath, body, { flag: 'wx' });
      const metadata = buildImageMetadata(getState ? getState() : { lastSensors: getSensors() }, {
        receivedAt: now, width: image.width, height: image.height, sizeBytes: body.length
      });
      fs.writeFileSync(filepath + '.json', JSON.stringify({ ...metadata, transport: 'https' }), { flag: 'wx' });
    } catch (_) {
      // Roll back incomplete files; no user-provided path is ever used.
      for (const file of [filepath, filepath + '.json']) { try { fs.unlinkSync(file); } catch (_) {} }
      return res.status(500).json({ error: 'Could not save image' });
    }
    try { onSaved({ filename, width: image.width, height: image.height, size: body.length }); }
    catch (_) { console.error('[UPLOAD] Image saved; notification/DB recording failed'); }
    res.status(201).json({ filename, width: image.width, height: image.height });
  });
}
module.exports = { installImageUpload };
