/**
 * automation.js - Intelligent Climate Controller for Growbox
 * Pleurotus ostreatus (Oyster Mushroom) Cultivation State Machine
 *
 * Implements 3 biological phases + Manual mode:
 * 1. INCUBATION: Dark, Substrate temp ~24°C, background FAE every 3h, high CO2 allowed.
 * 2. PINNING: Cold shock ~15°C, high RH 92-96%, CO2 < 900 ppm, 10h light, frequent FAE.
 * 3. FRUITING: Air temp ~18°C, RH 85-90%, CO2 < 1000 ppm, 12h light, regular FAE.
 * 4. MANUAL: Direct user control via dashboard/MQTT with safety overrides.
 *
 * Coordination & Safety:
 * - Priority Ladder: SAFETY > TEMPERATURE > CO2/FAE > HUMIDITY > LIGHT
 * - MIST_LOCK_AFTER_FAN: 90s delay after exhaust fan turns OFF before humidifier can run.
 * - HEATER_COOLDOWN: Heater fan (Relay 3) runs during heating + 45s post-purge.
 * - MAX_PURGE_SAFETY: Continuous ventilation capped at 5 minutes to protect fan motors.
 * - ANTI_CHATTER: 30s minimum hold between non-emergency relay toggles.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'climate_state.json');

const DEFAULT_PROFILES = {
  incubation: {
    id: 'incubation',
    name: 'Инкубация (Колонизация)',
    description: 'Разрастание мицелия в темноте. Контроль по температуре субстрата.',
    controlTempBy: 'substrate', // 'substrate' | 'air'
    tempTarget: 24.0,
    tempOn: 23.0,
    tempOff: 24.5,
    tempMaxSafe: 29.0,
    humTarget: 80.0,
    humOn: 74.0,
    humOff: 82.0,
    co2PurgeEnabled: false,
    co2Max: 15000,
    co2Target: 10000,
    lightMode: 'off', // 'off' | 'schedule' | 'on'
    lightOnHour: 8,
    lightOffHour: 20,
    faeIntervalMin: 180, // 3 hours
    faeDurationSec: 45,  // circulation only (Fan 1)
    faeFan: 4            // Relay 4 (Intake/Circulation)
  },
  pinning: {
    id: 'pinning',
    name: 'Инициация (Примордии / Холодовой шок)',
    description: 'Снижение температуры, падение CO2, появление света и высокая влажность.',
    controlTempBy: 'air',
    tempTarget: 15.5,
    tempOn: 14.0,
    tempOff: 16.5,
    tempMaxSafe: 25.0,
    humTarget: 95.0,
    humOn: 92.0,
    humOff: 96.0,
    co2PurgeEnabled: true,
    co2Max: 950,
    co2Target: 750,
    lightMode: 'schedule',
    lightOnHour: 9,
    lightOffHour: 19, // 10h light
    faeIntervalMin: 20,
    faeDurationSec: 45,
    faeFan: 'both'     // Relays 4 and 5
  },
  fruiting: {
    id: 'fruiting',
    name: 'Плодоношение (Рост тел)',
    description: 'Рост шляпок без избытка влаги и CO2. Сбалансированный воздухообмен.',
    controlTempBy: 'air',
    tempTarget: 18.0,
    tempOn: 16.5,
    tempOff: 19.5,
    tempMaxSafe: 26.0,
    humTarget: 88.0,
    humOn: 85.0,
    humOff: 90.0,
    co2PurgeEnabled: true,
    co2Max: 1000,
    co2Target: 800,
    lightMode: 'schedule',
    lightOnHour: 8,
    lightOffHour: 20, // 12h light
    faeIntervalMin: 20,
    faeDurationSec: 45,
    faeFan: 'both'     // Relays 4 and 5
  },
  manual: {
    id: 'manual',
    name: 'Ручной режим',
    description: 'Автоматика отключена. Управление реле напрямую с веб-панели.',
    controlTempBy: 'none',
    lightMode: 'manual'
  }
};

class ClimateController {
  constructor(mqttClient) {
    this.mqttClient = mqttClient;

    // Relay mapping:
    // 1: Humidifier (Увлажнитель)
    // 2: Heater (Нагреватель)
    // 3: Heater Fan (Вент. нагревателя)
    // 4: Fan 1 (Приток / циркуляция)
    // 5: Fan 2 (Вытяжка)
    // 6: Backlight (Подсветка)
    this.currentRelays = [false, false, false, false, false, false];
    this.desiredRelays = [false, false, false, false, false, false];
    this.lastRelayToggleTime = [0, 0, 0, 0, 0, 0];

    // Timings & Constants
    this.ANTI_CHATTER_MS = 30000;         // 30s minimum relay hold time
    this.MIST_LOCK_AFTER_FAN_MS = 90000;  // 90s lock of humidifier after exhaust fan stops
    this.HEATER_FAN_POST_PURGE_MS = 45000;// 45s fan cooldown after heater turns off
    this.MAX_PURGE_DURATION_MS = 300000;  // 5 minutes max continuous ventilation
    this.PURGE_COOLDOWN_MS = 120000;      // 2 minutes cooldown if max purge exceeded

    // Internal state trackers
    this.mode = 'fruiting'; // Default mode
    this.profiles = JSON.parse(JSON.stringify(DEFAULT_PROFILES));
    this.substate = 'NORMAL'; // NORMAL | CO2_PURGE | PERIODIC_FAE | MIST_LOCKED | HEATER_COOLDOWN | SAFETY_OVERRIDE
    this.safetyAlert = null;  // null | 'OVERHEAT' | 'OVERHUMIDITY' | 'SENSOR_FAIL'

    this.heaterOffTime = 0;
    this.exhaustFanOffTime = 0;
    this.purgeStartTime = 0;
    this.purgeCooldownUntil = 0;
    this.isPurgingCo2 = false;
    this.faeEndTime = 0;
    this.lastFaeStartTime = Date.now();

    this.lastSensors = {
      air_temp: null,
      humidity: null,
      pressure: null,
      substrate_temp: null,
      co2_ppm: null,
      updated_at: 0
    };

    // Load persisted state if exists
    this.loadState();

    // Start background evaluation loop (every 5 seconds)
    this.evalInterval = setInterval(() => this.evaluate(), 5000);

    // Heartbeat state broadcast (every 10 seconds)
    this.heartbeatInterval = setInterval(() => this.publishState(), 10000);
  }

  loadState() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.mode && this.profiles[parsed.mode]) {
          this.mode = parsed.mode;
        }
        if (parsed.profiles) {
          this.profiles = { ...this.profiles, ...parsed.profiles };
        }
        console.log(`[Climate] Loaded persisted state. Active mode: ${this.mode}`);
      }
    } catch (e) {
      console.error('[Climate] Error loading state file:', e.message);
    }
  }

  saveState() {
    try {
      const payload = {
        mode: this.mode,
        profiles: this.profiles,
        saved_at: new Date().toISOString()
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error('[Climate] Error saving state file:', e.message);
    }
  }

  setMode(newMode) {
    if (!this.profiles[newMode]) {
      throw new Error(`Unknown mode: ${newMode}`);
    }
    const prevMode = this.mode;
    this.mode = newMode;
    console.log(`[Climate] Mode changed: ${prevMode} -> ${this.mode}`);
    this.saveState();
    this.evaluate();
    this.publishState();
    return this.getState();
  }

  updateProfileSetpoints(modeId, newSetpoints) {
    if (!this.profiles[modeId]) {
      throw new Error(`Unknown mode: ${modeId}`);
    }
    this.profiles[modeId] = { ...this.profiles[modeId], ...newSetpoints };
    console.log(`[Climate] Setpoints updated for profile: ${modeId}`);
    this.saveState();
    this.evaluate();
    this.publishState();
    return this.profiles[modeId];
  }

  /**
   * Update hardware status received from ESP32
   */
  updateHardwareStatus(statusData) {
    if (Array.isArray(statusData.relays)) {
      statusData.relays.forEach((state, i) => {
        if (this.currentRelays[i] !== state) {
          // Hardware state changed
          const now = Date.now();
          // Detect Heater (relay 2) turning OFF
          if (i === 1 && this.currentRelays[1] === true && state === false) {
            this.heaterOffTime = now;
          }
          // Detect Exhaust fan (relay 5) turning OFF
          if (i === 4 && this.currentRelays[4] === true && state === false) {
            this.exhaustFanOffTime = now;
          }
          this.currentRelays[i] = state;
          this.lastRelayToggleTime[i] = now;
        }
      });
    }
  }

  /**
   * Process newly arrived sensor data from ESP32
   */
  processSensors(data) {
    this.lastSensors = {
      air_temp: data.air_temp !== undefined ? data.air_temp : this.lastSensors.air_temp,
      humidity: data.humidity !== undefined ? data.humidity : this.lastSensors.humidity,
      pressure: data.pressure !== undefined ? data.pressure : this.lastSensors.pressure,
      substrate_temp: data.substrate_temp !== undefined ? data.substrate_temp : this.lastSensors.substrate_temp,
      co2_ppm: data.co2_ppm !== undefined ? data.co2_ppm : this.lastSensors.co2_ppm,
      updated_at: Date.now()
    };

    // Immediate evaluation on fresh sensor readings
    this.evaluate();
  }

  /**
   * Core climate control state machine evaluation
   */
  evaluate() {
    const now = Date.now();
    const profile = this.profiles[this.mode];
    const s = this.lastSensors;

    // Default desired relays clone current state
    const desired = [...this.currentRelays];
    let activeSubstates = [];
    this.safetyAlert = null;

    // -------------------------------------------------------------
    // STEP 1: SAFETY OVERRIDES (Highest Priority)
    // -------------------------------------------------------------
    let safetyHeaterCutoff = false;
    let safetyHumidifierCutoff = false;

    // Overheat safety: Substrate >= 29°C or Air >= 40°C
    if ((s.substrate_temp !== null && s.substrate_temp >= 29.0) || 
        (s.air_temp !== null && s.air_temp >= 40.0)) {
      safetyHeaterCutoff = true;
      this.safetyAlert = 'OVERHEAT';
      activeSubstates.push('АВАРИЯ: ПЕРЕГРЕВ');
    }

    // Overhumidity cutoff: >= 98%
    if (s.humidity !== null && s.humidity >= 98.0) {
      safetyHumidifierCutoff = true;
      this.safetyAlert = 'OVERHUMIDITY';
      activeSubstates.push('ОТСЕЧКА ВЛАЖНОСТИ');
    }

    // Critical sensor disconnect during automatic temperature control
    if (this.mode !== 'manual') {
      const tempSensorVal = profile.controlTempBy === 'substrate' ? s.substrate_temp : s.air_temp;
      if (tempSensorVal === null || tempSensorVal <= -900) {
        safetyHeaterCutoff = true;
        this.safetyAlert = 'SENSOR_FAIL';
        activeSubstates.push('СБОЙ ДАТЧИКА');
      }
    }

    // If in MANUAL mode, apply safety overrides and return
    if (this.mode === 'manual') {
      if (safetyHeaterCutoff && this.currentRelays[1]) {
        this.requestRelay(2, false, true); // Force Heater OFF immediately
      }
      if (safetyHumidifierCutoff && this.currentRelays[0]) {
        this.requestRelay(1, false, true); // Force Humidifier OFF immediately
      }
      this.substate = this.safetyAlert ? `MANUAL (${this.safetyAlert})` : 'MANUAL';
      return;
    }

    // -------------------------------------------------------------
    // STEP 2: TEMPERATURE CONTROL (Heater R2 & Heater Fan R3)
    // -------------------------------------------------------------
    let heaterDesired = desired[1]; // current heater state
    const currTemp = profile.controlTempBy === 'substrate' ? s.substrate_temp : s.air_temp;

    if (safetyHeaterCutoff) {
      heaterDesired = false;
    } else if (currTemp !== null && currTemp > -900) {
      if (currTemp < profile.tempOn) {
        heaterDesired = true;
      } else if (currTemp >= profile.tempOff) {
        heaterDesired = false;
      }
    }

    desired[1] = heaterDesired;

    // Heater Fan (Relay 3): Active when heater is ON + post-purge cooldown
    let heaterFanDesired = false;
    if (desired[1]) {
      heaterFanDesired = true;
    } else {
      // Cooldown check
      const remainingCooldown = this.HEATER_FAN_POST_PURGE_MS - (now - this.heaterOffTime);
      if (this.heaterOffTime > 0 && remainingCooldown > 0) {
        heaterFanDesired = true;
        activeSubstates.push(`Охлаждение ТЭНа (${Math.ceil(remainingCooldown / 1000)}с)`);
      }
    }
    desired[2] = heaterFanDesired;

    // -------------------------------------------------------------
    // STEP 3: CO₂ & FAE VENTILATION (Fan 1 R4 & Fan 2 R5)
    // -------------------------------------------------------------
    let fanIntakeDesired = false;
    let fanExhaustDesired = false;

    if (profile.co2PurgeEnabled && s.co2_ppm !== null && s.co2_ppm > 0) {
      // Check CO2 purge trigger
      if (!this.isPurgingCo2 && s.co2_ppm > profile.co2Max) {
        if (now >= this.purgeCooldownUntil) {
          this.isPurgingCo2 = true;
          this.purgeStartTime = now;
          console.log(`[Climate] Starting CO2 purge: ${s.co2_ppm} ppm > ${profile.co2Max}`);
        } else {
          const waitSec = Math.ceil((this.purgeCooldownUntil - now) / 1000);
          activeSubstates.push(`Отдых вентиляции (${waitSec}с)`);
        }
      }

      // If active CO2 purge
      if (this.isPurgingCo2) {
        const purgeElapsed = now - this.purgeStartTime;
        if (s.co2_ppm <= profile.co2Target) {
          this.isPurgingCo2 = false;
          console.log(`[Climate] CO2 purge complete: reached ${s.co2_ppm} ppm`);
        } else if (purgeElapsed >= this.MAX_PURGE_DURATION_MS) {
          this.isPurgingCo2 = false;
          this.purgeCooldownUntil = now + this.PURGE_COOLDOWN_MS;
          console.warn(`[Climate] CO2 purge capped at 5 minutes to protect fan.`);
        } else {
          fanIntakeDesired = true;
          fanExhaustDesired = true;
          activeSubstates.push(`Продувка CO₂ (${s.co2_ppm} ppm)`);
        }
      }
    }

    // Periodic FAE (Fresh Air Exchange)
    const faeIntervalMs = (profile.faeIntervalMin || 20) * 60000;
    if (!this.isPurgingCo2) {
      if (now - this.lastFaeStartTime >= faeIntervalMs) {
        let durationSec = profile.faeDurationSec || 45;
        // Dynamic adaptive FAE: if CO2 low and condensation high, shorten burst
        if (this.mode === 'pinning' && s.co2_ppm !== null && s.co2_ppm < 700 && s.humidity !== null && s.humidity > 94) {
          durationSec = 30;
        }
        this.faeEndTime = now + (durationSec * 1000);
        this.lastFaeStartTime = now;
        console.log(`[Climate] Periodic FAE started for ${durationSec}s`);
      }

      if (now < this.faeEndTime) {
        const remainingFae = Math.ceil((this.faeEndTime - now) / 1000);
        activeSubstates.push(`FAE проветривание (${remainingFae}с)`);
        if (profile.faeFan === 4) {
          fanIntakeDesired = true;
        } else {
          fanIntakeDesired = true;
          fanExhaustDesired = true;
        }
      }
    }

    desired[3] = fanIntakeDesired;
    desired[4] = fanExhaustDesired;

    // -------------------------------------------------------------
    // STEP 4: HUMIDITY CONTROL (Humidifier R1 & MIST_LOCK_AFTER_FAN)
    // -------------------------------------------------------------
    let humidifierDesired = desired[0];
    const isExhaustRunning = desired[4] || this.currentRelays[4];
    const mistLockRemaining = this.MIST_LOCK_AFTER_FAN_MS - (now - this.exhaustFanOffTime);
    const isMistLocked = isExhaustRunning || (this.exhaustFanOffTime > 0 && mistLockRemaining > 0);

    if (safetyHumidifierCutoff) {
      humidifierDesired = false;
    } else if (isMistLocked) {
      humidifierDesired = false;
      if (mistLockRemaining > 0 && !isExhaustRunning) {
        activeSubstates.push(`Блокировка тумана (${Math.ceil(mistLockRemaining / 1000)}с)`);
      }
    } else if (s.humidity !== null && s.humidity > 0) {
      if (s.humidity < profile.humOn) {
        humidifierDesired = true;
      } else if (s.humidity >= profile.humOff) {
        humidifierDesired = false;
      }
    }

    desired[0] = humidifierDesired;

    // -------------------------------------------------------------
    // STEP 5: LIGHTING CONTROL (Backlight R6)
    // -------------------------------------------------------------
    let lightDesired = desired[5];
    if (profile.lightMode === 'off') {
      lightDesired = false;
    } else if (profile.lightMode === 'on') {
      lightDesired = true;
    } else if (profile.lightMode === 'schedule') {
      const currentHour = new Date().getHours();
      if (currentHour >= profile.lightOnHour && currentHour < profile.lightOffHour) {
        lightDesired = true;
      } else {
        lightDesired = false;
      }
    }
    desired[5] = lightDesired;

    // Set overall substate string
    this.substate = activeSubstates.length > 0 ? activeSubstates.join(' • ') : 'Норма';

    // -------------------------------------------------------------
    // STEP 6: APPLY RELAY COMMANDS VIA ANTI-CHATTER GUARD
    // -------------------------------------------------------------
    for (let i = 0; i < 6; i++) {
      const relayId = i + 1;
      const targetState = desired[i];
      const currentState = this.currentRelays[i];

      if (targetState !== currentState) {
        const timeSinceToggle = now - this.lastRelayToggleTime[i];
        const isEmergencyOff = (!targetState && (
          (relayId === 2 && safetyHeaterCutoff) ||
          (relayId === 1 && safetyHumidifierCutoff)
        ));

        // Allow immediate toggle if emergency OFF, else enforce ANTI_CHATTER
        if (isEmergencyOff || timeSinceToggle >= this.ANTI_CHATTER_MS) {
          this.requestRelay(relayId, targetState, isEmergencyOff);
        }
      }
    }
  }

  /**
   * Request a relay state change via MQTT
   */
  requestRelay(relayId, state, isEmergency = false) {
    const idx = relayId - 1;
    const now = Date.now();

    // Record special turn-off events
    if (relayId === 2 && this.currentRelays[1] === true && state === false) {
      this.heaterOffTime = now;
    }
    if (relayId === 5 && this.currentRelays[4] === true && state === false) {
      this.exhaustFanOffTime = now;
    }

    // Optimistically update
    this.currentRelays[idx] = state;
    this.lastRelayToggleTime[idx] = now;

    const payload = JSON.stringify({ relay: relayId, state });
    console.log(`[Climate -> MQTT] Setting Relay ${relayId} (${this.getRelayName(relayId)}) = ${state ? 'ON' : 'OFF'} ${isEmergency ? '[EMERGENCY]' : ''}`);

    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish('growbox/relay/set', payload);
    } else {
      console.warn('[Climate] MQTT client not connected, cannot send relay command');
    }
  }

  getRelayName(id) {
    const names = ['Увлажнитель', 'Нагреватель', 'Вент. нагревателя', 'Приток/Циркуляция', 'Вытяжка', 'Подсветка'];
    return names[id - 1] || `Relay ${id}`;
  }

  getState() {
    const now = Date.now();
    const mistLockRemaining = Math.max(0, Math.ceil((this.MIST_LOCK_AFTER_FAN_MS - (now - this.exhaustFanOffTime)) / 1000));
    const heaterCooldownRemaining = Math.max(0, Math.ceil((this.HEATER_FAN_POST_PURGE_MS - (now - this.heaterOffTime)) / 1000));
    const profile = this.profiles[this.mode];
    const faeIntervalMs = (profile?.faeIntervalMin || 20) * 60000;
    const nextFaeInSec = Math.max(0, Math.ceil((faeIntervalMs - (now - this.lastFaeStartTime)) / 1000));

    return {
      mode: this.mode,
      modeName: profile?.name || this.mode,
      substate: this.substate,
      safetyAlert: this.safetyAlert,
      profiles: this.profiles,
      activeProfile: profile,
      relays: this.currentRelays,
      timers: {
        mistLockRemainingSec: mistLockRemaining,
        heaterCooldownRemainingSec: heaterCooldownRemaining,
        nextFaeInSec: nextFaeInSec,
        isPurgingCo2: this.isPurgingCo2
      },
      lastSensors: this.lastSensors,
      timestamp: new Date().toISOString()
    };
  }

  publishState() {
    if (this.mqttClient && this.mqttClient.connected) {
      const state = this.getState();
      this.mqttClient.publish('growbox/controller/state', JSON.stringify(state));
    }
  }
}

module.exports = { ClimateController, DEFAULT_PROFILES };
