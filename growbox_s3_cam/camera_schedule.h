#pragma once
#include <stdint.h>

// Independent of Arduino so timing (including millis() rollover) is host-testable.
struct CameraSchedule {
  bool enabled = false;
  uint32_t interval_seconds = 600;
  uint32_t last_capture_ms = 0;
  void apply(bool enabled_value, uint32_t seconds, uint32_t now) {
    enabled = enabled_value;
    interval_seconds = seconds;
    last_capture_ms = now; // A changed schedule never causes an immediate burst.
  }
  bool due(uint32_t now) const {
    return enabled && static_cast<uint32_t>(now - last_capture_ms) >= interval_seconds * 1000U;
  }
  void captured(uint32_t now) { last_capture_ms = now; }
};
