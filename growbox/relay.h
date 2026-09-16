#ifndef RELAY_H
#define RELAY_H

#include <Arduino.h>

void setup_relays();
void set_relay(int index, bool state);
bool get_relay(int index);

// Safety Lockouts
bool is_heater_locked();
void lock_heater(bool locked);
void emergency_cutoff(const char* reason);

#endif
