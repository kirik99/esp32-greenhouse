/**
 * store.js - Universal Growbox Data Store
 *
 * JSON-based persistent storage for:
 *   - MushroomProfile (multi-stage, versioned)
 *   - GrowBox definitions
 *   - GrowCycle (active / archived)
 *   - HarvestRecord
 *   - PhotoMetadata (AI dataset linking)
 *   - GlobalSafety limits
 *
 * All mutations are atomic (write to .tmp then rename).
 * No species names are ever referenced in logic - purely data.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const EMPTY_STORE = {
  schema_version: 1,
  boxes: [],
  profiles: [],
  grow_cycles: [],
  photo_metadata: [],
  global_safety: {
    max_air_temp_c:       50.0,
    max_substrate_temp_c: 32.0,
    max_humidity_pct:     98.0,
    heater_max_runtime_s: 600,
    mqtt_timeout_s:       60
  }
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readRaw() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return JSON.parse(JSON.stringify(EMPTY_STORE));
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Store] Failed to parse store.json:', e.message);
    return JSON.parse(JSON.stringify(EMPTY_STORE));
  }
}

function writeRaw(data) {
  ensureDataDir();
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

const DEFAULT_PROFILES = require('./default_profiles');

// ---------------------------------------------------------------------------
// Store class
// ---------------------------------------------------------------------------
class Store {
  constructor() {
    this._db = readRaw();
    // Ensure all arrays/objects exist (migration-safe)
    if (!Array.isArray(this._db.boxes))          this._db.boxes = [];
    if (!Array.isArray(this._db.profiles))        this._db.profiles = [];
    if (!Array.isArray(this._db.grow_cycles))     this._db.grow_cycles = [];
    if (!Array.isArray(this._db.photo_metadata))  this._db.photo_metadata = [];
    if (!this._db.global_safety)                  this._db.global_safety = EMPTY_STORE.global_safety;

    // Seed default profiles if none exist
    if (this._db.profiles.length === 0) {
      this._db.profiles = JSON.parse(JSON.stringify(DEFAULT_PROFILES));
      this._save();
    }

    // Seed default box if none exist
    if (this._db.boxes.length === 0) {
      this._db.boxes.push({
        id: 'box_a',
        name: 'Камера 1 (Основная)',
        device_id: 'growbox_esp32',
        active_cycle_id: null,
        status: 'active',
        created_at: this._now()
      });
      this._save();
    }

    // Seed default active cycle if none exist
    if (this._db.grow_cycles.length === 0 && this._db.profiles.length > 0) {
      const defaultProfile = this._db.profiles[0];
      const initialCycle = {
        id: uuidv4(),
        box_id: 'box_a',
        profile_id: defaultProfile.id,
        profile_name: defaultProfile.name,
        profile_snapshot: JSON.parse(JSON.stringify(defaultProfile)),
        current_stage_id: defaultProfile.stages[0]?.id || 'stage_1',
        started_at: this._now(),
        completed_at: null,
        status: 'active',
        harvests: [],
        notes: 'Инициализирован по умолчанию'
      };
      this._db.grow_cycles.push(initialCycle);
      this._db.boxes[0].active_cycle_id = initialCycle.id;
      this._db.boxes[0].status = 'active';
      this._save();
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _save() {
    this._db.updated_at = new Date().toISOString();
    writeRaw(this._db);
  }

  _now() {
    return new Date().toISOString();
  }

  // ── Global Safety ─────────────────────────────────────────────────────────

  getGlobalSafety() {
    return { ...this._db.global_safety };
  }

  updateGlobalSafety(patch) {
    this._db.global_safety = { ...this._db.global_safety, ...patch };
    this._save();
    return this.getGlobalSafety();
  }

  // ── Boxes ─────────────────────────────────────────────────────────────────

  getBoxes() {
    return this._db.boxes.map(b => ({ ...b }));
  }

  getBox(id) {
    const b = this._db.boxes.find(x => x.id === id);
    return b ? { ...b } : null;
  }

  createBox({ id, name, device_id }) {
    if (this._db.boxes.find(b => b.id === id)) {
      throw new Error(`Box with id "${id}" already exists`);
    }
    const box = {
      id: id || uuidv4(),
      name: name || 'Unnamed Box',
      device_id: device_id || null,
      active_cycle_id: null,
      status: 'idle',
      created_at: this._now()
    };
    this._db.boxes.push(box);
    this._save();
    return { ...box };
  }

  updateBox(id, patch) {
    const idx = this._db.boxes.findIndex(b => b.id === id);
    if (idx === -1) throw new Error(`Box "${id}" not found`);
    this._db.boxes[idx] = { ...this._db.boxes[idx], ...patch, updated_at: this._now() };
    this._save();
    return { ...this._db.boxes[idx] };
  }

  // ── Profiles ──────────────────────────────────────────────────────────────

  getProfiles() {
    return this._db.profiles.map(p => ({ ...p, stages: [...(p.stages || [])] }));
  }

  getProfile(id) {
    const p = this._db.profiles.find(x => x.id === id);
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }

  createProfile(data) {
    const now = this._now();
    const profile = {
      id:          data.id          || uuidv4(),
      name:        data.name        || 'Unnamed Profile',
      species:     data.species     || '',
      strain:      data.strain      || '',
      description: data.description || '',
      version:     1,
      stages:      data.stages      || [],
      created_at:  now,
      updated_at:  now
    };
    if (this._db.profiles.find(p => p.id === profile.id)) {
      throw new Error(`Profile id "${profile.id}" already exists`);
    }
    this._db.profiles.push(profile);
    this._save();
    return JSON.parse(JSON.stringify(profile));
  }

  updateProfile(id, patch) {
    const idx = this._db.profiles.findIndex(p => p.id === id);
    if (idx === -1) throw new Error(`Profile "${id}" not found`);
    const prev = this._db.profiles[idx];
    this._db.profiles[idx] = {
      ...prev,
      ...patch,
      id:      prev.id,      // immutable
      version: prev.version + 1,
      created_at: prev.created_at,
      updated_at: this._now()
    };
    this._save();
    return JSON.parse(JSON.stringify(this._db.profiles[idx]));
  }

  cloneProfile(id, overrides = {}) {
    const src = this.getProfile(id);
    if (!src) throw new Error(`Profile "${id}" not found`);
    const now = this._now();
    const clone = {
      ...src,
      ...overrides,
      id:         uuidv4(),
      name:       overrides.name || `${src.name} (копия)`,
      version:    1,
      stages:     JSON.parse(JSON.stringify(src.stages)),
      created_at: now,
      updated_at: now
    };
    this._db.profiles.push(clone);
    this._save();
    return JSON.parse(JSON.stringify(clone));
  }

  deleteProfile(id) {
    // Guard: don't delete if active cycles reference it
    const active = this._db.grow_cycles.find(
      c => c.profile_id === id && c.status === 'active'
    );
    if (active) throw new Error(`Cannot delete profile "${id}" – active cycle "${active.id}" references it`);
    const before = this._db.profiles.length;
    this._db.profiles = this._db.profiles.filter(p => p.id !== id);
    if (this._db.profiles.length === before) throw new Error(`Profile "${id}" not found`);
    this._save();
    return { deleted: id };
  }

  // ── Grow Cycles ───────────────────────────────────────────────────────────

  getCycles(filter = {}) {
    let list = this._db.grow_cycles;
    if (filter.box_id)  list = list.filter(c => c.box_id  === filter.box_id);
    if (filter.status)  list = list.filter(c => c.status  === filter.status);
    return list.map(c => JSON.parse(JSON.stringify(c)));
  }

  getCycle(id) {
    const c = this._db.grow_cycles.find(x => x.id === id);
    return c ? JSON.parse(JSON.stringify(c)) : null;
  }

  /** Start a new grow cycle on a box with a given profile version */
  startCycle({ box_id, profile_id, notes = '' }) {
    const box     = this.getBox(box_id);
    if (!box)     throw new Error(`Box "${box_id}" not found`);
    const profile = this.getProfile(profile_id);
    if (!profile) throw new Error(`Profile "${profile_id}" not found`);
    if (!profile.stages || profile.stages.length === 0) {
      throw new Error(`Profile "${profile_id}" has no stages`);
    }

    // End any currently active cycle on this box
    const existing = this._db.grow_cycles.find(
      c => c.box_id === box_id && c.status === 'active'
    );
    if (existing) {
      existing.status   = 'interrupted';
      existing.ended_at = this._now();
    }

    const now       = this._now();
    const firstStage = profile.stages.sort((a, b) => a.order - b.order)[0];
    const cycle = {
      id:               uuidv4(),
      box_id,
      profile_id,
      profile_version:  profile.version,
      profile_snapshot: JSON.parse(JSON.stringify(profile)), // immutable snapshot
      current_stage_id: firstStage.id,
      stage_started_at: now,
      cycle_started_at: now,
      status:           'active',
      notes,
      harvests:         []
    };

    this._db.grow_cycles.push(cycle);
    this.updateBox(box_id, { active_cycle_id: cycle.id, status: 'active' });
    this._save();
    return JSON.parse(JSON.stringify(cycle));
  }

  /** Switch to the next (or a specific) stage within an active cycle */
  setStage(cycleId, stageId) {
    const idx = this._db.grow_cycles.findIndex(c => c.id === cycleId);
    if (idx === -1) throw new Error(`Cycle "${cycleId}" not found`);
    const cycle   = this._db.grow_cycles[idx];
    const profile = cycle.profile_snapshot;
    const stage   = (profile.stages || []).find(s => s.id === stageId);
    if (!stage) throw new Error(`Stage "${stageId}" not found in cycle profile`);

    cycle.current_stage_id = stageId;
    cycle.stage_started_at = this._now();
    this._save();
    return JSON.parse(JSON.stringify(cycle));
  }

  /** Log a harvest flush */
  addHarvest(cycleId, { flush_number, weight_grams, quality_rating = null, notes = '' }) {
    const idx = this._db.grow_cycles.findIndex(c => c.id === cycleId);
    if (idx === -1) throw new Error(`Cycle "${cycleId}" not found`);
    const harvest = {
      id:             uuidv4(),
      flush_number:   flush_number || 1,
      timestamp:      this._now(),
      weight_grams:   weight_grams || 0,
      quality_rating,
      notes
    };
    this._db.grow_cycles[idx].harvests.push(harvest);
    this._save();
    return { ...harvest };
  }

  /** Mark cycle as completed or stopped */
  completeCycle(cycleId, status = 'completed') {
    const idx = this._db.grow_cycles.findIndex(c => c.id === cycleId);
    if (idx === -1) throw new Error(`Cycle "${cycleId}" not found`);
    const cycle = this._db.grow_cycles[idx];
    cycle.status   = status;
    cycle.ended_at = this._now();

    // Free the box
    this.updateBox(cycle.box_id, { active_cycle_id: null, status: 'idle' });
    this._save();
    return JSON.parse(JSON.stringify(cycle));
  }

  // ── Photo Metadata ────────────────────────────────────────────────────────

  /**
   * Save photo metadata record for AI dataset linking.
   * @param {object} meta - { filename, box_id, sensors, actuators }
   */
  addPhoto(meta) {
    const box   = this.getBox(meta.box_id);
    const cycle = box?.active_cycle_id
      ? this.getCycle(box.active_cycle_id)
      : null;

    const record = {
      photo_id:      uuidv4(),
      filename:      meta.filename || '',
      box_id:        meta.box_id   || null,
      grow_cycle_id: cycle?.id               || null,
      profile_id:    cycle?.profile_id       || null,
      stage_id:      cycle?.current_stage_id || null,
      timestamp:     this._now(),
      sensors:       meta.sensors   || {},
      actuators:     meta.actuators || {}
    };

    this._db.photo_metadata.push(record);
    // Keep only last 5000 records in memory to avoid unbounded growth
    if (this._db.photo_metadata.length > 5000) {
      this._db.photo_metadata = this._db.photo_metadata.slice(-5000);
    }
    this._save();
    return { ...record };
  }

  getPhotos(filter = {}) {
    let list = this._db.photo_metadata;
    if (filter.box_id)        list = list.filter(p => p.box_id        === filter.box_id);
    if (filter.grow_cycle_id) list = list.filter(p => p.grow_cycle_id === filter.grow_cycle_id);
    if (filter.stage_id)      list = list.filter(p => p.stage_id      === filter.stage_id);
    return list.map(p => ({ ...p }));
  }

  // ── Export / Import ───────────────────────────────────────────────────────

  exportProfile(id) {
    const p = this.getProfile(id);
    if (!p) throw new Error(`Profile "${id}" not found`);
    return p;
  }

  importProfile(data) {
    // Strip id so a fresh one is generated (prevent collision on import)
    const { id: _ignored, ...rest } = data;
    return this.createProfile(rest);
  }

  /** Full dataset export for AI/ML */
  exportDataset() {
    return {
      exported_at:    this._now(),
      schema_version: this._db.schema_version,
      boxes:          this.getBoxes(),
      profiles:       this.getProfiles(),
      grow_cycles:    this.getCycles(),
      photo_metadata: this.getPhotos()
    };
  }
}

// Singleton
const store = new Store();

module.exports = store;
