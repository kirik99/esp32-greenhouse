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

void set_relay(int index, bool state) {
  // index is 1-6 for user, internally 0-5
  int internal_idx = index - 1;
  if (internal_idx >= 0 && internal_idx < NUM_RELAYS) {
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
