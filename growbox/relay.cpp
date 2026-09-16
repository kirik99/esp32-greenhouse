#include "relay.h"
#include "config.h"

const int relay_pins[NUM_RELAYS] = {
  PIN_RELAY_1, PIN_RELAY_2, PIN_RELAY_3,
  PIN_RELAY_4, PIN_RELAY_5, PIN_RELAY_6
};

bool relay_states[NUM_RELAYS] = {false, false, false, false, false, false};

void setup_relays() {
  for (int i = 0; i < NUM_RELAYS; i++) {
    pinMode(relay_pins[i], OUTPUT);
    digitalWrite(relay_pins[i], HIGH); // LOW-active, so HIGH is OFF (safe state)
    relay_states[i] = false;
  }
}

static bool heater_locked = false;

bool is_heater_locked() {
  return heater_locked;
}

void lock_heater(bool locked) {
  heater_locked = locked;
  if (locked) {
    // Ensure heater is physically turned off
    int internal_idx = 1; // relay 2 is index 1
    digitalWrite(relay_pins[internal_idx], HIGH);
    relay_states[internal_idx] = false;
    Serial.println("[SAFETY ALERT] Heater LOCKED due to emergency cutoff!");
  } else {
    Serial.println("[SAFETY INFO] Heater UNLOCKED (normal conditions restored)");
  }
}

void emergency_cutoff(const char* reason) {
  Serial.printf("[EMERGENCY CUTOFF TRIGGERED] Reason: %s\n", reason);
  // Cutoff heater (relay 2) and heater fan (relay 3)
  set_relay(2, false);
  set_relay(3, false);
  lock_heater(true);
  // Force exhaust fan (relay 5) ON to vent heat
  set_relay(5, true);
}

void set_relay(int index, bool state) {
  // index is 1-6 for user, internally 0-5
  int internal_idx = index - 1;
  if (internal_idx >= 0 && internal_idx < NUM_RELAYS) {
    // Block turning heater ON if safety lockout is active
    if (index == 2 && state && heater_locked) {
      Serial.println("[SAFETY REJECT] Blocked turning Heater ON: Overheat Lockout active!");
      return;
    }
    digitalWrite(relay_pins[internal_idx], state ? LOW : HIGH);
    relay_states[internal_idx] = state;
    Serial.printf("Relay %d set to %s\n", index, state ? "ON" : "OFF");
  }
}

bool get_relay(int index) {
  int internal_idx = index - 1;
  if (internal_idx >= 0 && internal_idx < NUM_RELAYS) {
    return relay_states[internal_idx];
  }
  return false;
}

