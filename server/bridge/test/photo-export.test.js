const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const express = require('express');
const yauzl = require('yauzl');
const { installPhotoExport, parseRange } = require('../photo-export');

const auth = { Authorization: 'Bearer test-session' };
const DAY = { from: '2026-10-26', to: '2026-10-26' };
async function fixture(t, options = {}) {
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-export-'));
  const app = express(); app.use(express.json());
  let clock = Date.parse('2026-10-26T12:00:00Z');
  installPhotoExport(app, { imagesDir, timeZone: 'Europe/Moscow', now: () => clock,
    requireAuth: (req, res, next) => req.get('Authorization') === auth.Authorization ? next() : res.status(401).json({ error: 'PIN required' }), ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(imagesDir, { recursive: true, force: true }); });
  return { imagesDir, base, tick: n => { clock += n; },
    preview: (query = 'from=2026-10-26&to=2026-10-26') => fetch(base + '/api/photo-exports/preview?' + query, { headers: auth }),
    prepare: (body = DAY) => fetch(base + '/api/photo-exports', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    photo(name, timestamp, data = Buffer.from([0xff, 0xd8, 0xff, 0xd9])) {
      const file = path.join(imagesDir, name); fs.writeFileSync(file, data);
      if (timestamp !== undefined) fs.writeFileSync(file + '.json', JSON.stringify({ received_at: timestamp, sensors: { humidity: 82 } }));
      return file;
    }
  };
}
function unzip(data) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(data, { lazyEntries: true }, (err, zip) => {
    if (err) return reject(err);
    const entries = {};
    zip.on('error', reject); zip.on('end', () => resolve(entries));
    zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = []; stream.on('error', reject); stream.on('data', b => chunks.push(b));
      stream.on('end', () => { entries[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
    }));
    zip.readEntry();
  }));
}

test('export range accepts only real inclusive dates or explicit all, never paths or extra fields', () => {
  assert.deepEqual(parseRange(DAY), { ...DAY, all: false, include_metadata: false });
  for (const value of [null, [], {}, { ...DAY, from: '2026-02-30' }, { ...DAY, from: '2026-10-27' },
    { ...DAY, to: '../.env' }, { all: true, ...DAY }, { all: 'true' }, { ...DAY, include_metadata: 'true' }, { ...DAY, path: '/root' }])
    assert.throws(() => parseRange(value));
  assert.equal(parseRange({ all: true }).all, true);
  assert.equal(parseRange({ from: '2024-02-29', to: '2024-02-29' }).from, '2024-02-29');
});

test('export always requires PIN even for preview/config; no files match => no download ticket', async t => {
  const f = await fixture(t);
  for (const route of ['/config', '/preview?all=1']) assert.equal((await fetch(f.base + '/api/photo-exports' + route)).status, 401);
  assert.equal((await fetch(f.base + '/api/photo-exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(DAY) })).status, 401);
  const config = await fetch(f.base + '/api/photo-exports/config', { headers: auth }).then(r => r.json());
  assert.equal(config.server_today, '2026-10-26'); assert.equal(config.timezone, 'Europe/Moscow');
  assert.equal((await f.preview()).status, 200); assert.equal((await f.preview().then(r => r.json())).count, 0);
  assert.equal((await f.prepare()).status, 404);
  assert.equal((await f.preview('from=2026-02-30&to=2026-10-26')).status, 400);
});

test('Moscow date bounds include whole days; sidecar receipt time wins over filename; old files fall back explicitly', async t => {
  const f = await fixture(t);
  f.photo('2026-10-26_01-00-00_before.jpg', '2026-10-25T20:59:59.999Z');
  f.photo('2026-10-25_23-00-00_start.jpg', '2026-10-25T21:00:00.000Z');
  f.photo('2026-10-26_23-59-59_end.jpg', '2026-10-26T20:59:59.999Z');
  f.photo('2026-10-26_01-00-00_after.jpg', '2026-10-26T21:00:00.000Z');
  f.photo('2026-10-26_12-00-00_legacy.jpg');
  const fallback = f.photo('legacy.png'); fs.utimesSync(fallback, new Date('2026-10-26T10:00:00Z'), new Date('2026-10-26T10:00:00Z'));
  const bad = f.photo('2026-10-26_14-00-00_badmeta.jpg'); fs.writeFileSync(bad + '.json', '{broken');
  const info = await f.preview().then(r => r.json());
  assert.equal(info.count, 5); assert.equal(info.fallback_dates, 3); assert.equal(info.metadata_available, 2);
  const prepared = await f.prepare({ ...DAY, include_metadata: true }).then(r => r.json());
  const download = await fetch(f.base + prepared.download_url); assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/zip/);
  assert.match(download.headers.get('content-disposition'), /growbox-photos_2026-10-26_2026-10-26\.zip/);
  const entries = await unzip(Buffer.from(await download.arrayBuffer()));
  assert.equal(Object.keys(entries).filter(n => n.startsWith('photos/')).length, 5);
  assert.equal(Object.keys(entries).filter(n => n.startsWith('metadata/')).length, 2);
  assert.ok(entries['photos/2026-10-25_23-00-00_start.jpg']);
  assert.ok(!entries['photos/2026-10-26_01-00-00_before.jpg']);
  const manifest = JSON.parse(entries['manifest.json']);
  assert.equal(manifest.timezone, 'Europe/Moscow'); assert.equal(manifest.photos.find(p => p.filename === 'legacy.png').date_source, 'file_mtime');
  assert.ok(!JSON.stringify(manifest).includes(f.imagesDir));
  assert.equal(fs.readdirSync(f.imagesDir).filter(n => n.endsWith('.jpg') || n.endsWith('.png')).length, 7);
});

test('ZIP is photo-only by default and excludes secrets, folders, symlinks and hardlinks', async t => {
  const f = await fixture(t);
  const file = f.photo('2026-10-26_00-00-00.jpg', '2026-10-26T00:00:00Z');
  fs.writeFileSync(path.join(f.imagesDir, '.env'), 'SECRET=never-export');
  fs.mkdirSync(path.join(f.imagesDir, '2026-10-26_directory.jpg'));
  fs.writeFileSync(path.join(f.imagesDir, 'notes.json'), '{}');
  const outside = path.join(path.dirname(f.imagesDir), path.basename(f.imagesDir) + '-private.txt');
  fs.writeFileSync(outside, 'private'); t.after(() => fs.unlinkSync(outside));
  fs.linkSync(outside, path.join(f.imagesDir, 'hardlink.jpg'));
  try { fs.symlinkSync(outside, path.join(f.imagesDir, 'symlink.jpg')); } catch (err) { if (!['EPERM', 'EACCES'].includes(err.code)) throw err; }
  const job = await f.prepare({ all: true }).then(r => r.json());
  const entries = await unzip(Buffer.from(await fetch(f.base + job.download_url).then(r => r.arrayBuffer())));
  assert.deepEqual(Object.keys(entries).sort(), ['manifest.json', 'photos/' + path.basename(file)]);
  assert.ok(!Buffer.concat(Object.values(entries)).includes(Buffer.from('never-export')));
});

test('tickets expire, are one-use even with racing downloads, and HEAD does not consume them', async t => {
  const f = await fixture(t); f.photo('2026-10-26_00-00-00.jpg');
  const first = await f.prepare().then(r => r.json());
  assert.equal((await fetch(f.base + first.download_url, { method: 'HEAD' })).status, 405);
  const responses = await Promise.all([fetch(f.base + first.download_url), fetch(f.base + first.download_url)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 404]);
  await Promise.all(responses.map(r => r.arrayBuffer()));
  assert.equal((await fetch(f.base + first.download_url)).status, 404);
  const second = await f.prepare().then(r => r.json()); f.tick(120001);
  assert.equal((await fetch(f.base + second.download_url)).status, 404);
});

test('resource limits refuse oversized selection and excessive pending tickets before streaming', async t => {
  const f = await fixture(t, { limits: { photos: 1, tickets: 1 } });
  f.photo('2026-10-26_00-00-00.jpg'); f.photo('2026-10-27_00-00-00.jpg');
  assert.equal((await f.prepare({ all: true })).status, 413);
  assert.equal((await f.prepare()).status, 201); assert.equal((await f.prepare()).status, 429);
  f.tick(120001); assert.equal((await f.prepare()).status, 201);
  const small = await fixture(t, { limits: { bytes: 2 } }); small.photo('2026-10-26_00-00-00.jpg');
  assert.equal((await small.preview()).status, 413);
});

test('changed photo is rejected instead of silently exporting a different file', async t => {
  const f = await fixture(t); const file = f.photo('2026-10-26_00-00-00.jpg');
  const job = await f.prepare().then(r => r.json()); fs.writeFileSync(file, 'changed');
  const response = await fetch(f.base + job.download_url);
  assert.equal(response.status, 409); assert.equal(response.headers.get('content-disposition'), null);
});

test('cancelling a streaming download releases the active slot and source stream', async t => {
  let active = 0;
  const f = await fixture(t, { limits: { active: 1 }, onActiveChange: n => { active = n; } });
  f.photo('2026-10-26_00-00-00.jpg', undefined, Buffer.alloc(8 * 1024 * 1024, 0x55));
  const job = await f.prepare().then(r => r.json());
  const { request, response } = await new Promise((resolve, reject) => {
    const request = http.get(f.base + job.download_url, response => { response.pause(); resolve({ request, response }); });
    request.on('error', reject);
  });
  assert.equal(active, 1); assert.equal((await f.prepare()).status, 429);
  response.destroy(); request.destroy();
  for (let i = 0; i < 100 && active; i++) await sleep(10);
  assert.equal(active, 0); assert.equal((await f.prepare()).status, 201);
});
