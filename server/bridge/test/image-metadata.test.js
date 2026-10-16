/**
 * Image metadata tests: the same contract is used by the bridge (writer) and by
 * the Telegram bot (reader), so an archived frame is always captioned with the
 * readings that belonged to it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildImageMetadata, writeImageMetadata, readImageMetadata, metadataPath } = require('../image-metadata');

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-meta-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const climateState = {
  mode: 'pinning',
  modeName: 'Инициация (Примордии / Холодовой шок)',
  substate: 'Норма',
  safetyAlert: 'OVERHEAT',
  lastSensors: {
    air_temp: 15.5, humidity: 93.5, pressure: 1004.2, substrate_temp: 14.1, co2_ppm: 780,
    updated_at: 1700000000000
  }
};

test('metadata snapshot is taken at receive time and survives a round trip', () => {
  const dir = tmpDir();
  const imagePath = path.join(dir, '2026-10-12_21-00-00.jpg');
  fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const receivedAt = new Date('2026-10-12T18:00:00.000Z');
  const metadata = buildImageMetadata(climateState, { receivedAt, width: 160, height: 120, sizeBytes: 1234 });
  writeImageMetadata(imagePath, metadata);

  const stored = JSON.parse(fs.readFileSync(metadataPath(imagePath), 'utf8'));
  assert.equal(stored.received_at, '2026-10-12T18:00:00.000Z');
  assert.equal(stored.sensors.air_temp, 15.5);
  assert.equal(stored.sensors.updated_at, 1700000000000);
  assert.equal(stored.mode, 'pinning');
  assert.equal(stored.safetyAlert, 'OVERHEAT');
  assert.equal(stored.width, 160);

  const read = readImageMetadata(imagePath);
  assert.equal(read.archived, true);
  assert.equal(read.receivedAt, '2026-10-12T18:00:00.000Z');
  assert.equal(read.sensors.humidity, 93.5);
  assert.equal(read.sensorsUpdatedAt, 1700000000000);
  assert.equal(read.modeName, climateState.modeName);
  assert.equal(read.safetyAlert, 'OVERHEAT');
});

test('the snapshot is frozen: later sensor changes do not alter stored metadata', () => {
  const dir = tmpDir();
  const imagePath = path.join(dir, 'frame.jpg');
  fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const live = { ...climateState, lastSensors: { ...climateState.lastSensors } };
  writeImageMetadata(imagePath, buildImageMetadata(live, { receivedAt: new Date(), width: 160, height: 120, sizeBytes: 10 }));

  // The controller keeps reading new values afterwards
  live.lastSensors.air_temp = 30;
  live.lastSensors.humidity = 10;
  live.modeName = 'Плодоношение';

  const read = readImageMetadata(imagePath);
  assert.equal(read.sensors.air_temp, 15.5);
  assert.equal(read.sensors.humidity, 93.5);
  assert.equal(read.modeName, climateState.modeName);
});

test('a frame without a sidecar reports "no metadata" instead of inventing readings', () => {
  const dir = tmpDir();
  const imagePath = path.join(dir, 'legacy.jpg');
  fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  assert.equal(readImageMetadata(imagePath), null);
});

test('a corrupt sidecar is surfaced as an error, not silently as fake data', () => {
  const dir = tmpDir();
  const imagePath = path.join(dir, 'broken.jpg');
  fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(metadataPath(imagePath), '{ not json');

  assert.throws(() => readImageMetadata(imagePath), /Cannot read metadata/);
});

test('missing sensor channels are stored as null, never as zeros', () => {
  const metadata = buildImageMetadata(
    { mode: 'manual', modeName: 'Ручной режим', substate: 'MANUAL', safetyAlert: null, lastSensors: { air_temp: 20, humidity: null, updated_at: 0 } },
    { receivedAt: new Date('2026-10-12T00:00:00Z'), width: 160, height: 120, sizeBytes: 5 }
  );

  assert.equal(metadata.sensors.air_temp, 20);
  assert.equal(metadata.sensors.humidity, null);
  assert.equal(metadata.sensors.co2_ppm, null);
  assert.equal(metadata.sensors.updated_at, null);
  assert.equal(metadata.safetyAlert, null);
});
