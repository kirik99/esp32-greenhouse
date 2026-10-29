#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cctype>

// No heap, networking, flash writes or Arduino dependency. Caller provides locking.
struct DiagnosticEntry {
  uint32_t seq = 0, uptime_ms = 0;
  char message[192] = {};
};

inline bool diagnostic_contains(const char* text, const char* needle) {
  for (; *text; ++text) {
    const char* a = text; const char* b = needle;
    while (*a && *b && std::tolower(static_cast<unsigned char>(*a)) == std::tolower(static_cast<unsigned char>(*b))) { ++a; ++b; }
    if (!*b) return true;
  }
  return false;
}

inline const char* diagnostic_level(const char* line) {
  if (diagnostic_contains(line, "error") || diagnostic_contains(line, " err") || diagnostic_contains(line, "failed") || diagnostic_contains(line, "cutoff") ||
      diagnostic_contains(line, "alert") || diagnostic_contains(line, "HTTP 4") || diagnostic_contains(line, "HTTP 5")) return "ERROR";
  if (diagnostic_contains(line, "warn") || diagnostic_contains(line, "timeout") || diagnostic_contains(line, "disconnected") || diagnostic_contains(line, "ignored")) return "WARN";
  return "INFO";
}

class DiagnosticBuffer {
 public:
  static constexpr size_t Capacity = 48;
  uint32_t dropped = 0;
  size_t count() const { return count_; }

  void feed(char c, uint32_t uptime, const char* const* secrets, size_t secret_count) {
    if (c == '\r') return;
    if (c != '\n') {
      if (size_ < sizeof(line_) - 1) line_[size_++] = (static_cast<unsigned char>(c) >= 32 && c != 127) ? c : ' ';
      else overflow_ = true;
      return;
    }
    line_[size_] = 0;
    if (overflow_) { ++dropped; }
    // Ignore progress dots, banners and arbitrary library output. Firmware app lines only.
    else if (line_[0] == '[' || std::strncmp(line_, "Relay ", 6) == 0 || std::strncmp(line_, "Sensors:", 8) == 0) {
      const char* safe = line_;
      bool sensitive = false;
      const char* markers[] = {"password", "passwd", "token", "secret", "authorization", "private key", "signature", "://", "[MQTT MSG]"};
      for (const char* marker : markers) if (diagnostic_contains(line_, marker)) sensitive = true;
      for (size_t i = 0; i < secret_count; ++i) if (secrets[i] && *secrets[i] && std::strstr(line_, secrets[i])) sensitive = true;
      if (sensitive) safe = "[LOG] Sensitive diagnostic omitted (see USB serial)";
      else if (std::strncmp(line_, "[WIFI", 5) == 0) safe = "[WIFI] Network connection event (details available over USB)";
      if (count_ == Capacity) { head_ = (head_ + 1) % Capacity; --count_; ++dropped; }
      DiagnosticEntry& entry = entries_[(head_ + count_) % Capacity];
      entry.seq = ++seq_; entry.uptime_ms = uptime;
      std::strncpy(entry.message, safe, sizeof(entry.message) - 1);
      entry.message[sizeof(entry.message) - 1] = 0;
      ++count_;
    }
    size_ = 0; overflow_ = false;
  }

  bool pop(DiagnosticEntry& entry) {
    if (!count_) return false;
    entry = entries_[head_]; head_ = (head_ + 1) % Capacity; --count_; return true;
  }

 private:
  DiagnosticEntry entries_[Capacity];
  char line_[192] = {};
  size_t head_ = 0, count_ = 0, size_ = 0;
  uint32_t seq_ = 0;
  bool overflow_ = false;
};
