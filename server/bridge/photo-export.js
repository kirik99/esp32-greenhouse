const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

class ExportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const DEFAULT_LIMITS = { photos: 5000, bytes: 512 * 1024 * 1024, scanned: 100000, tickets: 8, active: 2, scans: 2 };
const IMAGE_NAME = /^[a-z0-9][a-z0-9_.-]{0,179}\.(?:jpe?g|png)$/i;
const META_LIMIT = 64 * 1024;
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01') return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function parseRange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['from', 'to', 'all', 'include_metadata'].includes(k)))
    throw new ExportError(400, 'Неверные параметры экспорта');
  if (value.include_metadata !== undefined && typeof value.include_metadata !== 'boolean') throw new ExportError(400, 'Неверный параметр метаданных');
  if (value.all === true) {
    if (value.from || value.to) throw new ExportError(400, 'Выберите период или все даты');
    return { all: true, include_metadata: !!value.include_metadata };
  }
  if ((value.all !== undefined && value.all !== false) || !validDay(value.from) || !validDay(value.to) || value.from > value.to)
    throw new ExportError(400, 'Укажите корректные даты: начало не позже окончания');
  return { from: value.from, to: value.to, all: false, include_metadata: !!value.include_metadata };
}
function sameFile(a, b) { return a.isFile() && a.nlink === 1 && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }
function dayFormatter(timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return date => {
      const p = Object.fromEntries(formatter.formatToParts(date).map(v => [v.type, v.value]));
      return `${p.year}-${p.month}-${p.day}`;
    };
  } catch (_) { throw new ExportError(503, 'Неверный часовой пояс сервера'); }
}
async function readSidecar(file) {
  let handle;
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > META_LIMIT) return null;
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!sameFile(await handle.stat(), stat)) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > stat.size || count > META_LIMIT || !sameFile(await handle.stat(), stat)) return null;
    const text = buffer.subarray(0, count).toString('utf8');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return { stat, data };
  } catch (err) {
    if (['ENOENT', 'ELOOP', 'EACCES', 'EPERM'].includes(err.code) || err instanceof SyntaxError) return null;
    throw err;
  } finally { if (handle) await handle.close(); }
}
function photoDay(name, stat, metadata, formatDay) {
  const timestamp = metadata?.received_at;
  if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) {
    const date = new Date(timestamp);
    if (Number.isFinite(date.getTime())) return { day: formatDay(date), source: 'received_at', received_at: date.toISOString() };
  }
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})(?:_[a-z0-9_-]+)?\./i.exec(name);
  if (match && validDay(match[1]) && +match[2] < 24 && +match[3] < 60 && +match[4] < 60)
    return { day: match[1], source: 'filename', received_at: null };
  return { day: formatDay(stat.mtime), source: 'file_mtime', received_at: null };
}
async function selectPhotos(imagesDir, range, { timeZone, limits, signal }) {
  const formatDay = dayFormatter(timeZone);
  const selected = [];
  let bytes = 0, metadataCount = 0, fallbackCount = 0, skipped = 0, scanned = 0;
  let directory;
  try { directory = await fs.promises.opendir(imagesDir); }
  catch (err) { if (err.code === 'ENOENT') return { files: [], bytes: 0, metadataCount: 0, fallbackCount: 0, skipped: 0 }; throw err; }
  for await (const entry of directory) {
    if (signal?.aborted) throw new ExportError(499, 'Запрос отменён');
    if (++scanned > limits.scanned) throw new ExportError(413, 'Архив слишком большой для подсчёта');
    if (!IMAGE_NAME.test(entry.name)) continue;
    if (!entry.isFile()) { skipped++; continue; }
    const file = path.join(imagesDir, entry.name);
    let stat;
    try { stat = await fs.promises.lstat(file); } catch (err) { if (err.code === 'ENOENT') { skipped++; continue; } throw err; }
    if (!stat.isFile() || stat.nlink !== 1) { skipped++; continue; }
    const meta = await readSidecar(file + '.json');
    const date = photoDay(entry.name, stat, meta?.data, formatDay);
    if (!range.all && (date.day < range.from || date.day > range.to)) continue;
    bytes += stat.size + (range.include_metadata && meta ? meta.stat.size : 0);
    if (selected.length >= limits.photos || bytes > limits.bytes) throw new ExportError(413, 'Слишком большой ZIP. Выберите меньший период');
    if (meta) metadataCount++;
    if (date.source !== 'received_at') fallbackCount++;
    selected.push({ name: entry.name, file, stat, ...date, metadata: range.include_metadata && meta ? { file: file + '.json', stat: meta.stat } : null });
  }
  selected.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
  return { files: selected, bytes, metadataCount, fallbackCount, skipped };
}

function installPhotoExport(app, { imagesDir, requireAuth, timeZone = process.env.TZ || 'Europe/Moscow', now = Date.now, limits: overrides = {}, onActiveChange = () => {} }) {
  if (typeof requireAuth !== 'function') throw new Error('Photo export requires authentication');
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const tickets = new Map();
  let active = 0, scans = 0;
  const purge = () => { for (const [id, job] of tickets) if (job.expires <= now()) tickets.delete(id); };
  const fail = (res, err) => {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    res.removeHeader('Content-Disposition');
    res.type('application/json');
    res.status(err instanceof ExportError ? err.status : 500).json({ error: err instanceof ExportError ? err.message : 'Не удалось подготовить архив фото' });
  };
  const summary = (selection, range) => ({ range, timezone: timeZone, count: selection.files.length, total_bytes: selection.bytes,
    metadata_available: selection.metadataCount, fallback_dates: selection.fallbackCount, skipped_files: selection.skipped,
    max_photos: limits.photos, max_bytes: limits.bytes, server_today: dayFormatter(timeZone)(new Date(now())) });
  const prepare = download => async (req, res) => {
    let scanning = false;
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    res.set('Cache-Control', 'no-store');
    try {
      const range = parseRange(download ? req.body : { ...req.query,
        ...(req.query.all === '1' ? { all: true } : {}),
        ...(req.query.include_metadata === '1' ? { include_metadata: true } : req.query.include_metadata === '0' ? { include_metadata: false } : {}) });
      purge();
      if (scans >= limits.scans || (download && (tickets.size >= limits.tickets || active >= limits.active)))
        throw new ExportError(429, 'Другой экспорт уже выполняется. Повторите позже');
      scans++; scanning = true;
      const selection = await selectPhotos(imagesDir, range, { timeZone, limits, signal: controller.signal });
      if (res.destroyed) return;
      const info = summary(selection, range);
      if (!download) return res.json(info);
      if (!info.count) throw new ExportError(404, 'За выбранный период фотографий нет');
      const label = range.all ? 'all' : `${range.from}_${range.to}`;
      const filename = `growbox-photos_${label}.zip`;
      const manifest = JSON.stringify({ ...info, created_at: new Date(now()).toISOString(), timestamp_note: 'Dates refer to server receipt, not camera shutter time. Legacy fallback is recorded per photo.',
        photos: selection.files.map(f => ({ filename: f.name, day: f.day, date_source: f.source, received_at: f.received_at })) }, null, 2);
      if (selection.bytes + Buffer.byteLength(manifest) > limits.bytes) throw new ExportError(413, 'Слишком большой ZIP. Выберите меньший период');
      const id = crypto.randomBytes(32).toString('hex');
      const expires = now() + 120000;
      tickets.set(id, { ...selection, manifest, filename, expires });
      res.status(201).json({ ...info, filename, download_url: `/api/photo-exports/${id}`, expires_at: new Date(expires).toISOString() });
    } catch (err) { fail(res, err); }
    finally { if (scanning) scans--; res.removeListener('close', cancel); }
  };
  app.get('/api/photo-exports/config', requireAuth, (req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ timezone: timeZone, server_today: dayFormatter(timeZone)(new Date(now())), max_photos: limits.photos, max_bytes: limits.bytes }); }
    catch (err) { fail(res, err); }
  });
  app.get('/api/photo-exports/preview', requireAuth, prepare(false));
  app.post('/api/photo-exports', requireAuth, prepare(true));
  app.get('/api/photo-exports/:ticket', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    if (req.method === 'HEAD') return res.status(405).end();
    purge();
    const job = /^[a-f0-9]{64}$/.test(req.params.ticket) ? tickets.get(req.params.ticket) : null;
    if (!job) return res.status(404).json({ error: 'Ссылка недействительна или истекла. Подготовьте архив заново' });
    if (active >= limits.active) return res.status(429).json({ error: 'Другой архив уже скачивается. Повторите позже' });
    let archive;
    try { const { ZipArchive } = await import('archiver'); archive = new ZipArchive({ store: true }); }
    catch (err) { return fail(res, err); }
    if (res.destroyed) { archive.abort(); return; }
    if (tickets.get(req.params.ticket) !== job || job.expires <= now()) { archive.abort(); return res.status(404).json({ error: 'Ссылка уже использована или истекла' }); }
    if (active >= limits.active) { archive.abort(); return res.status(429).json({ error: 'Другой архив уже скачивается' }); }
    tickets.delete(req.params.ticket); // Short-lived, single-use capability; never a PIN session token in a URL.
    active++; onActiveChange(active);
    const controller = new AbortController();
    const sources = new Set();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true; controller.abort();
      for (const source of sources) source.destroy();
      archive.abort(); active--; onActiveChange(active);
    };
    res.once('close', cleanup); res.once('finish', cleanup);
    archive.on('warning', err => { fail(res, err); cleanup(); });
    archive.on('error', err => { fail(res, err); cleanup(); });
    async function appendFile(entry, name) {
      const stat = await fs.promises.lstat(entry.file);
      if (!sameFile(stat, entry.stat)) throw new ExportError(409, 'Архив изменился. Подготовьте выгрузку заново');
      const handle = await fs.promises.open(entry.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let source;
      try {
        if (!sameFile(await handle.stat(), entry.stat) || controller.signal.aborted) throw new ExportError(409, 'Запрос отменён или файл изменился');
        source = handle.createReadStream({ end: Math.max(0, stat.size - 1) });
      } catch (err) { await handle.close(); throw err; }
      sources.add(source);
      source.once('close', () => sources.delete(source));
      source.on('error', err => archive.emit('error', err));
      const done = once(archive, 'entry', { signal: controller.signal });
      archive.append(source, { name, date: stat.mtime, stats: stat });
      await done;
    }
    try {
      res.attachment(job.filename); res.type('application/zip');
      archive.pipe(res);
      for (const photo of job.files) {
        if (controller.signal.aborted) break;
        await appendFile(photo, 'photos/' + photo.name);
        if (photo.metadata) await appendFile(photo.metadata, 'metadata/' + photo.name + '.json');
      }
      if (!controller.signal.aborted) { archive.append(job.manifest, { name: 'manifest.json' }); await archive.finalize(); }
    } catch (err) { fail(res, err); cleanup(); }
  });
}

module.exports = { installPhotoExport, parseRange, photoDay, selectPhotos, DEFAULT_LIMITS };
