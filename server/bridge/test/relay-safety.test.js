/**
 * Relay safety tests: the shared manual-control entry point
 * (ClimateController.manualSetRelay) used by the REST API and the Telegram bot.
 *
 * Runs fully offline: MQTT is a stub, no hardware and no network are involved.
 */

process.env.CLIMATE_STATE_FILE = require('path').join(require('os').tmpdir(), `growbox-test-state-${process.pid}.json`);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ClimateController, RELAY_NAMES, NUM_RELAYS, isValidReading, SENSOR_STALE_MS } = require('../automation');
const { StubMqtt } = require('./helpers/stub-mqtt');

function makeController() {
  const mqtt = new StubMqtt();
  const climate = new ClimateController(mqtt);
  climate.stop(); // no background loops inside tests
  climate.mode = 'fruiting';
  mqtt.clear();
  return { climate, mqtt };
}

test.after(() => {
  try { fs.unlinkSync(process.env.CLIMATE_STATE_FILE); } catch { /* ignore */ }
});

test('relay numbering and types are validated before anything is published', () => {
  const { climate, mqtt } = makeController();

  for (const bad of [0, 7, 8, 9, -1, 1.5, NaN, 'x', undefined, null]) {
    const result = climate.manualSetRelay(bad, true);
    assert.equal(result.ok, false, `relay ${String(bad)} must be rejected`);
    assert.equal(result.kind, 'invalid', 'argument problems are classified as invalid (HTTP 400)');
    assert.match(result.error, /Недопустимый номер реле/);
  }

  for (const bad of ['true', 1, 0, null, undefined, {}]) {
    const result = climate.manualSetRelay(1, bad);
    assert.equal(result.ok, false, `state ${JSON.stringify(bad)} must be rejected`);
    assert.equal(result.kind, 'invalid');
    assert.match(result.error, /boolean/);
  }

  assert.equal(mqtt.relayCommands().length, 0, 'nothing may reach MQTT');
});

test('valid relay numbers 1..6 are accepted with a boolean state', () => {
  const { climate, mqtt } = makeController();
  climate.processSensors({ air_temp: 20, humidity: 60, substrate_temp: 20, co2_ppm: 800 });
  mqtt.clear();

  for (let id = 1; id <= NUM_RELAYS; id++) {
    const result = climate.manualSetRelay(id, true);
    assert.equal(result.ok, true, `relay ${id} (${RELAY_NAMES[id - 1]}) should be allowed`);
  }
  assert.deepEqual(mqtt.relayCommands().map(c => c.relay).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test('heater ON is refused while the OVERHEAT cutoff is active - nothing is published', () => {
  const { climate, mqtt } = makeController();
  climate.processSensors({ air_temp: 45, humidity: 60, substrate_temp: 20, co2_ppm: 800 });
  mqtt.clear();

  const result = climate.manualSetRelay(2, true);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'blocked', 'safety refusals are classified as blocked (HTTP 409)');
  assert.match(result.error, /OVERHEAT/);
  assert.equal(mqtt.relayCommands().length, 0, 'a refused ON must never reach MQTT');
});

test('substrate overheat blocks the heater even when air is cool', () => {
  const { climate, mqtt } = makeController();
  climate.processSensors({ air_temp: 18, humidity: 60, substrate_temp: 30.5, co2_ppm: 800 });
  mqtt.clear();

  assert.equal(climate.manualSetRelay(2, true).ok, false);
  assert.equal(mqtt.relayCommands().length, 0);
});

test('humidifier ON is refused at >= 98 % RH, and OFF stays available', () => {
  const { climate, mqtt } = makeController();
  climate.processSensors({ air_temp: 20, humidity: 99, substrate_temp: 20, co2_ppm: 800 });
  mqtt.clear();

  const refused = climate.manualSetRelay(1, true);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /OVERHUMIDITY/);
  assert.equal(mqtt.relayCommands().length, 0, 'a refused ON must never reach MQTT');

  const off = climate.manualSetRelay(1, false);
  assert.equal(off.ok, true, 'emergency OFF must always be allowed');
  assert.deepEqual(mqtt.relayCommands(), [{ relay: 1, state: false }]);
});

test('heater ON is refused without valid temperature data (SENSOR_FAIL / -999)', () => {
  const { climate, mqtt } = makeController();

  // No telemetry at all
  assert.equal(climate.manualSetRelay(2, true).ok, false);
  assert.equal(mqtt.relayCommands().length, 0);

  // Explicit firmware "no data" sentinel
  climate.processSensors({ air_temp: -999, humidity: 60, substrate_temp: -999, co2_ppm: 800 });
  const result = climate.manualSetRelay(2, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /SENSOR_FAIL|валидных данных/);
  assert.equal(mqtt.relayCommands().filter(c => c.relay === 2).length, 0);
});

test('heater ON is refused when telemetry is stale', () => {
  const { climate, mqtt } = makeController();
  climate.processSensors({ air_temp: 20, humidity: 60, substrate_temp: 20, co2_ppm: 800 });
  climate.lastSensors.updated_at = Date.now() - SENSOR_STALE_MS - 1000; // freeze the feed
  mqtt.clear();

  const result = climate.manualSetRelay(2, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /устарел/);
  assert.equal(mqtt.relayCommands().length, 0);
});

test('humidifier ON is allowed without valid humidity data (sensor disconnected)', () => {
  const { climate, mqtt } = makeController();
  climate.processSensors({ air_temp: 20, humidity: -999, substrate_temp: 20, co2_ppm: 800 });
  mqtt.clear();

  const result = climate.manualSetRelay(1, true);
  assert.equal(result.ok, true, 'manual humidifier ON must succeed even if humidity is -999');
  assert.deepEqual(mqtt.relayCommands(), [{ relay: 1, state: true }]);
});

test('humidifier ON is allowed even with no sensor telemetry at all', () => {
  const { climate, mqtt } = makeController(); // no telemetry at all
  const result = climate.manualSetRelay(1, true);
  assert.equal(result.ok, true);
  assert.deepEqual(mqtt.relayCommands(), [{ relay: 1, state: true }]);
});

test('auto mode flags sensor unavailable and does not start humidifier without sensor', () => {
  const { climate, mqtt } = makeController();
  climate.mode = 'fruiting';
  climate.processSensors({ air_temp: 20, humidity: -999, substrate_temp: 20, co2_ppm: 800 });
  climate.evaluate();

  assert.match(climate.substate, /Влажность: датчик недоступен/);
  assert.equal(climate.currentRelays[0], false, 'auto mode must not turn on humidifier without valid humidity');
});

test('humidifier max continuous runtime shuts off humidifier after 15 minutes', () => {
  const { climate, mqtt } = makeController();
  climate.processSensors({ air_temp: 20, humidity: 60, substrate_temp: 20, co2_ppm: 800 });
  climate.manualSetRelay(1, true);
  assert.equal(climate.currentRelays[0], true);
  mqtt.clear();

  // Advance time past 15 minutes (900000 ms)
  climate.humidifierOnTime = Date.now() - 900001;
  climate.evaluate();

  assert.equal(climate.currentRelays[0], false, 'humidifier must be shut off after exceeding max runtime');
  assert.equal(mqtt.relayCommands().some(c => c.relay === 1 && c.state === false), true);
});

test('fans, heater fan and light only need a valid relay id', () => {
  const { climate, mqtt } = makeController(); // no telemetry at all

  for (const id of [3, 4, 5, 6]) {
    const result = climate.manualSetRelay(id, true);
    assert.equal(result.ok, true, `relay ${id} should not require sensor data`);
  }
  assert.deepEqual(mqtt.relayCommands().map(c => c.relay), [3, 4, 5, 6]);
});

test('automatic safety behaviour is unchanged', () => {
  const { climate, mqtt } = makeController();

  // Heater running, then air overheats -> controller forces it OFF immediately
  climate.processSensors({ air_temp: 20, humidity: 60, substrate_temp: 20, co2_ppm: 800 });
  climate.currentRelays = [false, true, true, false, false, false];
  mqtt.clear();

  climate.processSensors({ air_temp: 45, humidity: 60, substrate_temp: 20, co2_ppm: 800 });
  climate.evaluate();

  const heaterOff = mqtt.relayCommands().some(c => c.relay === 2 && c.state === false);
  assert.equal(heaterOff, true, 'auto control must still cut the heater on OVERHEAT');
  assert.equal(climate.safetyAlert, 'OVERHEAT');
});

test('reading validity helper matches the firmware sentinel convention', () => {
  assert.equal(isValidReading(-999), false);
  assert.equal(isValidReading(null), false);
  assert.equal(isValidReading(undefined), false);
  assert.equal(isValidReading(NaN), false);
  assert.equal(isValidReading('20'), false);
  assert.equal(isValidReading(0), true);
  assert.equal(isValidReading(21.5), true);
});
