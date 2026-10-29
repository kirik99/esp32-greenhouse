#include "../camera_schedule.h"
#include <cassert>
#include <cstdint>

int main() {
  CameraSchedule s;
  assert(!s.due(1000000)); // Default OFF; no initial snapshot.
  s.apply(true,60,1000);
  assert(!s.due(60999));
  assert(s.due(61000));
  s.captured(61000);
  assert(!s.due(61001));
  s.apply(false,60,62000);
  assert(!s.due(1000000));
  s.apply(true,600,1000000);
  assert(!s.due(1000001)); // Interval change must not create an immediate burst.
  assert(s.due(1600000));
  uint32_t before_rollover=UINT32_MAX-30000U;
  s.apply(true,60,before_rollover);
  assert(!s.due(1000));
  assert(s.due(static_cast<uint32_t>(before_rollover+60000U)));
  s.apply(true,86400,0);
  assert(!s.due(86399999));
  assert(s.due(86400000));
}
