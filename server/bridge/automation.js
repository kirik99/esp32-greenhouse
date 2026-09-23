const fs = require('fs');
const path = require('path');
const store = require('./store');

class UniversalClimateEngine {
  constructor(mqttClient, storeInstance = store) {
    this.mqttClient = mqttClient;
    this.store = storeInstance;
    
    // Maintain state per box
    this.boxes = new Map();

    // Defaults for evaluation intervals
    this.evalInterval = setInterval(() => {
      for (const boxId of this.boxes.keys()) {
        this.evaluateBox(boxId);
      }
      // Backward compatibility loop if no specific box logic runs
      if (this.boxes.size === 0) {
         this.evaluateBox('box_a');
      }
    }, 5000);

    this.heartbeatInterval = setInterval(() => {
      for (const boxId of this.boxes.keys()) {
        this.publishState(boxId);
      }
      if (this.boxes.size === 0) {
         this.publishState('box_a');
      }
    }, 10000);
  }

  // --- Constants ---
  get ANTI_CHATTER_MS() { return 30000; }
  get MIST_LOCK_AFTER_FAN_MS() { return 90000; }
  get HEATER_FAN_POST_PURGE_MS() { return 45000; }
  get MAX_PURGE_DURATION_MS() { return 300000; }
  get PURGE_COOLDOWN_MS() { return 120000; }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  _getBoxStateObj(boxId) {
    if (!this.boxes.has(boxId)) {
      this.boxes.set(boxId, {
        currentRelays: [false, false, false, false, false, false],
        lastRelayToggleTime: [0, 0, 0, 0, 0, 0],
        heaterOffTime: 0,
        exhaustFanOffTime: 0,
        purgeStartTime: 0,
        purgeCooldownUntil: 0,
        isPurgingCo2: false,
        faeEndTime: 0,
        lastFaeStartTime: Date.now(),
        lastSensors: {
          air_temp: null,
          humidity: null,
          pressure: null,
          substrate_temp: null,
          co2_ppm: null,
          updated_at: 0
        },
        substate: 'NORMAL',
        safetyAlert: null
      });
    }
    return this.boxes.get(boxId);
  }

  _getActiveStage(boxId) {
    const box = this.store.getBox(boxId);
    if (!box || !box.active_cycle_id) return null;
    const cycle = this.store.getCycle(box.active_cycle_id);
    if (!cycle || !cycle.profile_snapshot || !cycle.profile_snapshot.stages) return null;
    
    return cycle.profile_snapshot.stages.find(s => s.id === cycle.current_stage_id) || null;
  }

  // --------------------------------------------------------------------------
  // Hardware & Sensors
  // --------------------------------------------------------------------------

  processSensors(boxId, data) {
    if (typeof boxId === 'object') {
       data = boxId;
       boxId = 'box_a';
    }

    const state = this._getBoxStateObj(boxId);
    state.lastSensors = {
      air_temp: data.air_temp !== undefined ? data.air_temp : state.lastSensors.air_temp,
      humidity: data.humidity !== undefined ? data.humidity : state.lastSensors.humidity,
      pressure: data.pressure !== undefined ? data.pressure : state.lastSensors.pressure,
      substrate_temp: data.substrate_temp !== undefined ? data.substrate_temp : state.lastSensors.substrate_temp,
      co2_ppm: data.co2_ppm !== undefined ? data.co2_ppm : state.lastSensors.co2_ppm,
      updated_at: Date.now()
    };

    this.evaluateBox(boxId);
  }

  updateHardwareStatus(boxId, statusData) {
    if (typeof boxId === 'object') {
       statusData = boxId;
       boxId = 'box_a';
    }

    const state = this._getBoxStateObj(boxId);
    if (Array.isArray(statusData.relays)) {
      statusData.relays.forEach((relayState, i) => {
        if (state.currentRelays[i] !== relayState) {
          const now = Date.now();
          if (i === 1 && state.currentRelays[1] === true && relayState === false) {
            state.heaterOffTime = now;
          }
          if (i === 4 && state.currentRelays[4] === true && relayState === false) {
            state.exhaustFanOffTime = now;
          }
          state.currentRelays[i] = relayState;
          state.lastRelayToggleTime[i] = now;
        }
      });
    }
  }

  // --------------------------------------------------------------------------
  // Core Logic
  // --------------------------------------------------------------------------

  evaluateBox(boxId) {
    const now = Date.now();
    const state = this._getBoxStateObj(boxId);
    const activeStage = this._getActiveStage(boxId);
    const s = state.lastSensors;
    const globalSafety = this.store.getGlobalSafety();

    const desired = [...state.currentRelays];
    let activeSubstates = [];
    state.safetyAlert = null;

    let safetyHeaterCutoff = false;
    let safetyHumidifierCutoff = false;

    if ((s.substrate_temp !== null && s.substrate_temp >= globalSafety.max_substrate_temp_c) || 
        (s.air_temp !== null && s.air_temp >= globalSafety.max_air_temp_c)) {
      safetyHeaterCutoff = true;
      state.safetyAlert = 'OVERHEAT';
      activeSubstates.push('АВАРИЯ: ПЕРЕГРЕВ');
    }

    if (s.humidity !== null && s.humidity >= globalSafety.max_humidity_pct) {
      safetyHumidifierCutoff = true;
      state.safetyAlert = 'OVERHUMIDITY';
      activeSubstates.push('ОТСЕЧКА ВЛАЖНОСТИ');
    }

    if (!activeStage) {
      if (safetyHeaterCutoff && state.currentRelays[1]) {
        this.requestRelay(boxId, 2, false, true);
      }
      if (safetyHumidifierCutoff && state.currentRelays[0]) {
        this.requestRelay(boxId, 1, false, true);
      }
      state.substate = state.safetyAlert ? `IDLE (${state.safetyAlert})` : 'IDLE';
      return;
    }

    const tempSensorVal = s.air_temp;
    if (tempSensorVal === null || tempSensorVal <= -900) {
      safetyHeaterCutoff = true;
      state.safetyAlert = 'SENSOR_FAIL';
      activeSubstates.push('СБОЙ ДАТЧИКА');
    }

    // 2. TEMPERATURE
    let heaterDesired = desired[1];
    if (safetyHeaterCutoff) {
      heaterDesired = false;
    } else if (tempSensorVal !== null && tempSensorVal > -900) {
      if (tempSensorVal < activeStage.temp.heater_on) {
        heaterDesired = true;
      } else if (tempSensorVal >= activeStage.temp.heater_off) {
        heaterDesired = false;
      }
    }
    desired[1] = heaterDesired;

    let heaterFanDesired = false;
    if (desired[1]) {
      heaterFanDesired = true;
    } else {
      const remainingCooldown = this.HEATER_FAN_POST_PURGE_MS - (now - state.heaterOffTime);
      if (state.heaterOffTime > 0 && remainingCooldown > 0) {
        heaterFanDesired = true;
        activeSubstates.push(`Охлаждение ТЭНа (${Math.ceil(remainingCooldown / 1000)}с)`);
      }
    }
    desired[2] = heaterFanDesired;

    // 3. CO2 & FAE
    let fanIntakeDesired = false;
    let fanExhaustDesired = false;

    if (s.co2_ppm !== null && s.co2_ppm > 0) {
      if (!state.isPurgingCo2 && s.co2_ppm > activeStage.co2.max) {
        if (now >= state.purgeCooldownUntil) {
          state.isPurgingCo2 = true;
          state.purgeStartTime = now;
        } else {
          const waitSec = Math.ceil((state.purgeCooldownUntil - now) / 1000);
          activeSubstates.push(`Отдых вентиляции (${waitSec}с)`);
        }
      }

      if (state.isPurgingCo2) {
        const purgeElapsed = now - state.purgeStartTime;
        if (s.co2_ppm <= activeStage.co2.target) {
          state.isPurgingCo2 = false;
        } else if (purgeElapsed >= (activeStage.co2.max_purge_sec || 300) * 1000) {
          state.isPurgingCo2 = false;
          state.purgeCooldownUntil = now + this.PURGE_COOLDOWN_MS;
        } else {
          fanIntakeDesired = true;
          fanExhaustDesired = true;
          activeSubstates.push(`Продувка CO2 (${s.co2_ppm} ppm)`);
        }
      }
    }

    const faeIntervalMs = (activeStage.fae.interval_min || 20) * 60000;
    if (!state.isPurgingCo2 && activeStage.fae.enabled) {
      if (now - state.lastFaeStartTime >= faeIntervalMs) {
        let durationSec = activeStage.fae.duration_sec || 45;
        state.faeEndTime = now + (durationSec * 1000);
        state.lastFaeStartTime = now;
      }

      if (now < state.faeEndTime) {
        const remainingFae = Math.ceil((state.faeEndTime - now) / 1000);
        activeSubstates.push(`FAE проветривание (${remainingFae}с)`);
        if (activeStage.fae.fan === 4 || activeStage.fae.fan === 'intake') {
          fanIntakeDesired = true;
        } else {
          fanIntakeDesired = true;
          fanExhaustDesired = true;
        }
      }
    }
    desired[3] = fanIntakeDesired;
    desired[4] = fanExhaustDesired;

    // 4. HUMIDITY
    let humidifierDesired = desired[0];
    const isExhaustRunning = desired[4] || state.currentRelays[4];
    const mistLockRemaining = this.MIST_LOCK_AFTER_FAN_MS - (now - state.exhaustFanOffTime);
    const isMistLocked = isExhaustRunning || (state.exhaustFanOffTime > 0 && mistLockRemaining > 0);

    if (safetyHumidifierCutoff) {
      humidifierDesired = false;
    } else if (isMistLocked) {
      humidifierDesired = false;
      if (mistLockRemaining > 0 && !isExhaustRunning) {
        activeSubstates.push(`Блокировка тумана (${Math.ceil(mistLockRemaining / 1000)}с)`);
      }
    } else if (s.humidity !== null && s.humidity > 0) {
      if (s.humidity < activeStage.humidity.humidifier_on) {
        humidifierDesired = true;
      } else if (s.humidity >= activeStage.humidity.humidifier_off) {
        humidifierDesired = false;
      }
    }
    desired[0] = humidifierDesired;

    // 5. LIGHT
    let lightDesired = desired[5];
    if (!activeStage.light.enabled) {
      lightDesired = false;
    } else if (activeStage.light.schedule) {
      const currentHour = new Date().getHours();
      const onH = parseInt(activeStage.light.on_time.split(':')[0]);
      const offH = parseInt(activeStage.light.off_time.split(':')[0]);
      
      if (onH < offH) {
         lightDesired = (currentHour >= onH && currentHour < offH);
      } else {
         lightDesired = (currentHour >= onH || currentHour < offH);
      }
    } else {
      lightDesired = true;
    }
    desired[5] = lightDesired;

    state.substate = activeSubstates.length > 0 ? activeSubstates.join(' • ') : 'Норма';

    // 6. APPLY RELAYS
    for (let i = 0; i < 6; i++) {
      const relayId = i + 1;
      const targetState = desired[i];
      const currentState = state.currentRelays[i];

      if (targetState !== currentState) {
        const timeSinceToggle = now - state.lastRelayToggleTime[i];
        const isEmergencyOff = (!targetState && (
          (relayId === 2 && safetyHeaterCutoff) ||
          (relayId === 1 && safetyHumidifierCutoff)
        ));

        if (isEmergencyOff || timeSinceToggle >= this.ANTI_CHATTER_MS) {
          this.requestRelay(boxId, relayId, targetState, isEmergencyOff);
        }
      }
    }
  }

  requestRelay(boxId, relayId, relayState, isEmergency = false) {
    const idx = relayId - 1;
    const now = Date.now();
    const state = this._getBoxStateObj(boxId);

    if (relayId === 2 && state.currentRelays[1] === true && relayState === false) {
      state.heaterOffTime = now;
    }
    if (relayId === 5 && state.currentRelays[4] === true && relayState === false) {
      state.exhaustFanOffTime = now;
    }

    state.currentRelays[idx] = relayState;
    state.lastRelayToggleTime[idx] = now;

    const payload = JSON.stringify({ relay: relayId, state: relayState });
    
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish('growbox/relay/set', payload);
    }
  }

  getBoxState(boxId) {
    const state = this._getBoxStateObj(boxId);
    const now = Date.now();
    const activeStage = this._getActiveStage(boxId);
    
    const mistLockRemaining = Math.max(0, Math.ceil((this.MIST_LOCK_AFTER_FAN_MS - (now - state.exhaustFanOffTime)) / 1000));
    const heaterCooldownRemaining = Math.max(0, Math.ceil((this.HEATER_FAN_POST_PURGE_MS - (now - state.heaterOffTime)) / 1000));
    const faeIntervalMs = (activeStage?.fae?.interval_min || 20) * 60000;
    const nextFaeInSec = Math.max(0, Math.ceil((faeIntervalMs - (now - state.lastFaeStartTime)) / 1000));

    return {
      boxId,
      substate: state.substate,
      safetyAlert: state.safetyAlert,
      activeStage,
      relays: state.currentRelays,
      timers: {
        mistLockRemainingSec: mistLockRemaining,
        heaterCooldownRemainingSec: heaterCooldownRemaining,
        nextFaeInSec: nextFaeInSec,
        isPurgingCo2: state.isPurgingCo2
      },
      lastSensors: state.lastSensors,
      timestamp: new Date().toISOString()
    };
  }

  getState() {
    // Backward compatibility
    return this.getBoxState('box_a');
  }

  publishState(boxId) {
    if (this.mqttClient && this.mqttClient.connected) {
      const state = this.getBoxState(boxId);
      this.mqttClient.publish('growbox/controller/state', JSON.stringify(state));
    }
  }

  // Backwards compat mappings
  setMode(mode) {
    console.warn('setMode is deprecated in UniversalClimateEngine.');
    return this.getState();
  }

  updateProfileSetpoints(modeId, newSetpoints) {
    console.warn('updateProfileSetpoints is deprecated in UniversalClimateEngine.');
    return {};
  }
}

module.exports = { UniversalClimateEngine };
