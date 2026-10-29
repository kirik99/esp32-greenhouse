const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jpeg = require('jpeg-js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installImageUpload } = require('./image-upload');
test('binary upload: authentication, validation, limits, archive, metadata and notifications', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-http-test-'));
  const token = 'test-secret-'.repeat(5);
  const saved = [];
  const app = express();
  installImageUpload(app, { imagesDir: dir, token, maxBytes: 2048,
    getSensors: () => ({ substrate_temp: 24, updated_at: 123 }), onSaved: x => saved.push(x) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/upload-image`;
  const send = (body, secret = token, type = 'image/jpeg') => fetch(url, {
    method: 'POST', headers: { 'X-Upload-Token': secret, 'Content-Type': type }, body });
  try {
    const image = jpeg.encode({ data: Buffer.from([80,120,160,255]), width: 1, height: 1 }, 85).data;
    assert.equal((await send(image, '')).status, 401);
    assert.equal((await send(image, 'wrong')).status, 401);
    assert.equal((await send(image, token, 'application/json')).status, 415);
    assert.equal((await send(Buffer.from('not a jpeg'))).status, 400);
    assert.equal((await send(Buffer.from([255,216,0,0,255,217]))).status, 400);
    assert.equal((await send(Buffer.alloc(2049))).status, 413);
    assert.equal(fs.readdirSync(dir).length, 0);
    const response = await send(image);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.width, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, result.filename)), image);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, result.filename + '.json')));
    assert.equal(metadata.sensors.substrate_temp, 24);
    assert.equal(metadata.transport, 'https');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].size, image.length);
    const second = await (await send(image)).json();
    assert.notEqual(result.filename, second.filename);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('missing token fails closed', async () => {
  const app = express();
  installImageUpload(app, { token: '', imagesDir: '', getSensors: () => ({}), onSaved: () => {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/upload-image`, { method: 'POST' })).status, 503); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
