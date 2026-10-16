/**
 * image-metadata.js - sidecar metadata for archived camera frames.
 *
 * The ESP32 publishes frames without any capture timestamp (`format/width/height/data`
 * only), so the only trustworthy time is the moment the bridge received the frame.
 * The sidecar is therefore built from the *current* controller state at receive time
 * and stored next to the JPEG, which lets the Telegram bot caption an archived frame
 * with the readings that belonged to it instead of today's values.
 *
 * Writer (bridge) and reader (Telegram bot) share this module so the format cannot
 * drift apart.
 */

const fs = require('fs');

/** Sidecar path for an image file. */
function metadataPath(imagePath) {
  return `${imagePath}.json`;
}

/**
 * Build the metadata record for a freshly received frame.
 *
 * @param {object} climateState   ClimateController.getState() result
 * @param {object} frame          { receivedAt: Date|string, width, height, sizeBytes }
 * @returns {object}
 */
function buildImageMetadata(climateState, frame = {}) {
  const receivedAt = frame.receivedAt instanceof Date
    ? frame.receivedAt
    : new Date(frame.receivedAt || Date.now());
  const sensors = climateState?.lastSensors || {};

  return {
    // Server receive time - explicitly NOT a shutter timestamp.
    received_at: receivedAt.toISOString(),
    // Snapshot of the readings that were current when the frame arrived.
    sensors: {
      air_temp: sensors.air_temp ?? null,
      humidity: sensors.humidity ?? null,
      pressure: sensors.pressure ?? null,
      substrate_temp: sensors.substrate_temp ?? null,
      co2_ppm: sensors.co2_ppm ?? null,
      updated_at: sensors.updated_at || null
    },
    sensors_updated_at: sensors.updated_at || null,
    mode: climateState?.mode ?? null,
    modeName: climateState?.modeName ?? null,
    substate: climateState?.substate ?? null,
    safetyAlert: climateState?.safetyAlert ?? null,
    width: frame.width ?? null,
    height: frame.height ?? null,
    size_bytes: frame.sizeBytes ?? null
  };
}

/** Write the sidecar; returns the sidecar path. */
function writeImageMetadata(imagePath, metadata) {
  const target = metadataPath(imagePath);
  fs.writeFileSync(target, JSON.stringify(metadata, null, 2), 'utf8');
  return target;
}

/**
 * Read a sidecar. Returns null when the frame has none (frames archived before
 * metadata collection existed, or a lost sidecar) - callers must then state that
 * historical readings are unavailable rather than substituting current ones.
 */
function readImageMetadata(imagePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath(imagePath), 'utf8'));
    return {
      archived: true,
      receivedAt: parsed.received_at || null,
      sensors: parsed.sensors || {},
      sensorsUpdatedAt: parsed.sensors?.updated_at || parsed.sensors_updated_at || null,
      mode: parsed.mode,
      modeName: parsed.modeName,
      substate: parsed.substate,
      safetyAlert: parsed.safetyAlert || null
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw Object.assign(new Error(`Cannot read metadata for ${imagePath}: ${err.message}`), { cause: err });
    }
    return null;
  }
}

module.exports = { buildImageMetadata, writeImageMetadata, readImageMetadata, metadataPath };
