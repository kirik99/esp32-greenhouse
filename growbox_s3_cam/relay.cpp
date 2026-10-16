#include "relay.h"
#include "config.h"
#include "ota_update.h"

const int relay_pins[NUM_RELAYS] = {
  PIN_RELAY_1, PIN_RELAY_2, PIN_RELAY_3,
  PIN_RELAY_4, PIN_RELAY_5, PIN_RELAY_6
};

bool relay_states[NUM_RELAYS] = {false, false, false, false, false, false};
static portMUX_TYPE relay_mux = portMUX_INITIALIZER_UNLOCKED;

void setup_relays() {
  for (int i = 0; i < NUM_RELAYS; i++) {
    pinMode(relay_pins[i], OUTPUT);
    digitalWrite(relay_pins[i], HIGH); // LOW-active: HIGH is OFF (safe default)
    relay_states[i] = false;
  }
}

static bool heater_locked = false;

bool is_heater_locked() {
  portENTER_CRITICAL(&relay_mux);
  bool result = heater_locked;
  portEXIT_CRITICAL(&relay_mux);
  return result;
}

void lock_heater(bool locked) {
  portENTER_CRITICAL(&relay_mux);
  heater_locked = locked;
  if (locked) {
    int internal_idx = 1; // relay 2 is index 1
    digitalWrite(relay_pins[internal_idx], HIGH);
    relay_states[internal_idx] = false;
    portEXIT_CRITICAL(&relay_mux);
    Serial.println("[SAFETY ALERT] Heater LOCKED due to emergency cutoff!");
  } else {
    portEXIT_CRITICAL(&relay_mux);
    Serial.println("[SAFETY INFO] Heater UNLOCKED (normal conditions restored)");
  }
}

void emergency_cutoff(const char* reason) {
  Serial.printf("[EMERGENCY CUTOFF TRIGGERED] Reason: %s\n", reason);
  set_relay(2, false);
  set_relay(3, false);
  lock_heater(true);
  set_relay(5, true);
}

void set_relay(int index, bool state) {
  int internal_idx = index - 1;
  if (internal_idx >= 0 && internal_idx < NUM_RELAYS) {
    portENTER_CRITICAL(&relay_mux);
    if (state && ota_busy()) { portEXIT_CRITICAL(&relay_mux); return; }
    if (index == 2 && state && heater_locked) {
      portEXIT_CRITICAL(&relay_mux);
      Serial.println("[SAFETY REJECT] Blocked turning Heater ON: Overheat Lockout active!");
      return;
    }
    digitalWrite(relay_pins[internal_idx], state ? LOW : HIGH);
    relay_states[internal_idx] = state;
    portEXIT_CRITICAL(&relay_mux);
    Serial.printf("Relay %d set to %s\n", index, state ? "ON" : "OFF");
  }
}

bool get_relay(int index) {
  int internal_idx = index - 1;
  if (internal_idx >= 0 && internal_idx < NUM_RELAYS) {
    portENTER_CRITICAL(&relay_mux);
    bool result = relay_states[internal_idx];
    portEXIT_CRITICAL(&relay_mux);
    return result;
  }
  return false;
}
