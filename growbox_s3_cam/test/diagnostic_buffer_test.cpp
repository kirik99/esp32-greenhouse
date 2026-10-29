#include "../diagnostic_buffer.h"
#include <cassert>
#include <string>

int main() {
  DiagnosticBuffer buffer;
  const char* secrets[] = {"test-device-upload-credential", "hidden-wifi"};
  auto line = [&](const std::string& s) { for (char c : s) buffer.feed(c, 1234, secrets, 2); buffer.feed('\n', 1234, secrets, 2); };
  DiagnosticEntry e;
  line("...banner..."); assert(!buffer.pop(e));
  line("[CAMERA HTTPS] HTTP 201, sent 123 bytes");
  assert(buffer.pop(e) && e.seq == 1 && e.uptime_ms == 1234);
  assert(std::strcmp(diagnostic_level(e.message), "INFO") == 0);
  assert(std::strcmp(diagnostic_level("[CAMERA] Transfer failed"), "ERROR") == 0);
  assert(std::strcmp(diagnostic_level("[CAMERA HTTPS] HTTP 401, sent 20 bytes"), "ERROR") == 0);
  assert(std::strcmp(diagnostic_level("[SAFETY ALERT] Heater locked"), "ERROR") == 0);
  assert(std::strcmp(diagnostic_level("[MQTT] Disconnected"), "WARN") == 0);
  for (const char* text : {"[LOG] test-device-upload-credential", "[WIFI] hidden-wifi", "[MQTT MSG] -> credential", "[LOG] token=abcd", "[OTA] https://host/?secret=x"}) {
    line(text); assert(buffer.pop(e)); assert(std::strstr(e.message, "Sensitive diagnostic omitted"));
  }
  line("[WIFI OK] Connected to a network"); assert(buffer.pop(e)); assert(!std::strstr(e.message, "a network"));
  line("[CAMERA] " + std::string(300, 'x')); assert(!buffer.pop(e)); assert(buffer.dropped == 1);
  for (int i = 0; i < 60; ++i) line("[DIAG] sensor OK");
  assert(buffer.count() == 48 && buffer.dropped == 13);
  uint32_t previous = 0;
  while (buffer.pop(e)) { assert(e.seq > previous); previous = e.seq; }
  assert(!buffer.pop(e));
}
