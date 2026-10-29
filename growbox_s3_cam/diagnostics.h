#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

class DiagnosticSerialPort : public Print {
 public:
  using Print::write;
  size_t write(uint8_t value) override;
  size_t write(const uint8_t* data, size_t size) override;
};
extern DiagnosticSerialPort DiagnosticSerial;
void setup_diagnostics();
void fill_diagnostics_status(JsonObject object);
