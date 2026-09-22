#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>

void setup_sensors();
void read_sensors();
void check_safety_failsafes();
void calibrate_co2_zero();

extern float current_air_temp;
extern float current_humidity;
extern float current_pressure;
extern float current_substrate_temp;
extern int current_co2_ppm;
extern String current_alarm;
extern String sensor_diag;

// Per-sensor health flags and human readable reasons.
// They are published on growbox/sensors so the dashboard can explain a '--'
// instead of silently showing a sentinel.
extern bool sensor_bme_ok;
extern bool sensor_ds_ok;
extern bool sensor_co2_ok;
extern String sensor_bme_status;
extern String sensor_ds_status;
extern String sensor_co2_status;
extern String i2c_devices;     // devices found on the active I2C bus, e.g. "0x19,0x77"
extern int i2c_sda_active;     // pins the active I2C bus runs on
extern int i2c_scl_active;

#endif
