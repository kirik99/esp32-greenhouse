#include "ota_update.h"
#include "diagnostics.h"
#include "config.h"
#include "wifi_config.h"
#include "relay.h"
#include "camera_capture.h"
#include "mqtt_transport.h"
#include <WiFi.h>
#include <atomic>
#include <time.h>
#include <new>
#include <ctype.h>
#include <esp_ota_ops.h>
#include <esp_http_client.h>
#include <esp_crt_bundle.h>
#include <esp_mac.h>
#include <mbedtls/pk.h>
#include <mbedtls/base64.h>
#include <mbedtls/sha256.h>
#include <freertos/queue.h>

#ifndef OTA_ENABLED
#define OTA_ENABLED false
#endif
#ifndef OTA_PUBLIC_KEY_PEM
#define OTA_PUBLIC_KEY_PEM ""
#endif
#ifndef OTA_FIRMWARE_BASE_URL
#define OTA_FIRMWARE_BASE_URL ""
#endif
#ifndef OTA_DOWNLOAD_TOKEN
#define OTA_DOWNLOAD_TOKEN ""
#endif
#ifndef FIRMWARE_BUILD_NUMBER
#define FIRMWARE_BUILD_NUMBER 1
#endif
#define OTA_STR_IMPL(x) #x
#define OTA_STR(x) OTA_STR_IMPL(x)
static const char identity[] = "GROWBOX_OTA_V1:hzad-s3-n16r8:" OTA_STR(FIRMWARE_BUILD_NUMBER) ":";

struct Command {
  char device[36], url[257], hash[65], signature[345];
  uint32_t build, size, expires;
};
static QueueHandle_t commands;
static std::atomic<bool> busy{false};
static std::atomic<const char *> state{"disabled"};
static std::atomic<unsigned> progress{0};
static char device_id[36];
static const esp_partition_t *destination;
static bool ready = false;
static std::atomic<bool> verifying{false};
static uint32_t boot_ms;

static bool rollback_enabled() {
#if defined(CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE) && CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE
  return true;
#else
  return false;
#endif
}

static bool valid_url(const char *s) {
  if (!s || strncmp(s, "https://", 8) != 0 || strlen(s) > 256) return false;
  // No userinfo, queries, fragments, whitespace or escaped path surprises.
  for (const char *p = s + 8; *p; ++p)
    if (!(isalnum(static_cast<unsigned char>(*p)) || strchr(".-_/:", *p))) return false;
  return strchr(s + 8, '/') && s[8] != '/';
}

static bool signature_ok(const Command &c) {
  char canonical[512];
  int n = snprintf(canonical, sizeof(canonical), "growbox-ota-v1\n%s\nhzad-s3-n16r8\n%u\n%u\n%s\n%u\n%s\n",
      c.device, (unsigned)c.build, (unsigned)c.size, c.hash, (unsigned)c.expires, c.url);
  if (n < 0 || n >= (int)sizeof(canonical)) return false;
  unsigned char digest[32], sig[256];
  size_t sig_len = 0;
  if (mbedtls_sha256((const unsigned char *)canonical, n, digest, 0) != 0 ||
      mbedtls_base64_decode(sig, sizeof(sig), &sig_len, (const unsigned char *)c.signature, strlen(c.signature)) != 0 || sig_len != 256) return false;
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  bool ok = mbedtls_pk_parse_public_key(&pk, (const unsigned char *)OTA_PUBLIC_KEY_PEM, strlen(OTA_PUBLIC_KEY_PEM) + 1) == 0 &&
      mbedtls_pk_get_type(&pk) == MBEDTLS_PK_RSA && mbedtls_pk_get_bitlen(&pk) == 2048 &&
      mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, sizeof(digest), sig, sig_len) == 0;
  mbedtls_pk_free(&pk);
  return ok;
}

bool queue_ota(const char *json, size_t length) {
  if (!ready || busy.load() || !commands || length > 1536) return false;
  JsonDocument doc;
  if (deserializeJson(doc, json, length) || doc["protocol"] != 1 || doc["model"] != "hzad-s3-n16r8" ||
      !doc["build"].is<uint32_t>() || !doc["size"].is<uint32_t>() || !doc["expires"].is<uint32_t>()) return false;
  const char *device = doc["device_id"] | "", *url = doc["url"] | "";
  const char *hash = doc["sha256"] | "", *sig = doc["signature"] | "";
  if (strcmp(device, device_id) || !valid_url(url) || strlen(hash) != 64 || strlen(sig) != 344) return false;
  for (int i = 0; i < 64; ++i) if (!((hash[i] >= '0' && hash[i] <= '9') || (hash[i] >= 'a' && hash[i] <= 'f'))) return false;
  const String expected_url = String(OTA_FIRMWARE_BASE_URL) + hash + ".bin";
  if (expected_url != url) return false; // Never send download secret to an arbitrary signed URL.
  Command c{};
  strlcpy(c.device, device, sizeof(c.device)); strlcpy(c.url, url, sizeof(c.url));
  strlcpy(c.hash, hash, sizeof(c.hash)); strlcpy(c.signature, sig, sizeof(c.signature));
  c.build = doc["build"]; c.size = doc["size"]; c.expires = doc["expires"];
  if (c.build <= FIRMWARE_BUILD_NUMBER || c.size < 1024 || !destination || c.size > destination->size) return false;
  // One pending request; never queue updates while offline or overwrite one in progress.
  return xQueueSend(commands, &c, 0) == pdPASS;
}

static void download_task(void *arg) {
  Command c = *static_cast<Command *>(arg);
  delete static_cast<Command *>(arg);
  esp_http_client_config_t cfg{};
  cfg.url = c.url; cfg.crt_bundle_attach = esp_crt_bundle_attach;
  cfg.timeout_ms = 5000; cfg.disable_auto_redirect = true; cfg.buffer_size = 4096;
  esp_http_client_handle_t http = esp_http_client_init(&cfg);
  if (http) esp_http_client_set_header(http, "X-OTA-Token", OTA_DOWNLOAD_TOKEN);
  esp_ota_handle_t handle = 0;
  bool opened = false, started = false, ok = false;
  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  do {
    state = "downloading";
    if (!http || esp_http_client_open(http, 0) != ESP_OK) break;
    opened = true;
    if (esp_http_client_fetch_headers(http) != c.size || esp_http_client_get_status_code(http) != 200) break;
    if (esp_ota_begin(destination, c.size, &handle) != ESP_OK) break;
    started = true;
    if (mbedtls_sha256_starts(&sha, 0) != 0) break;
    uint8_t buffer[4096];
    size_t received = 0;
    uint32_t start = millis();
    while (received < c.size && millis() - start < 180000) {
      int count = esp_http_client_read(http, (char *)buffer, min(sizeof(buffer), size_t(c.size - received)));
      if (count <= 0 || mbedtls_sha256_update(&sha, buffer, count) != 0 || esp_ota_write(handle, buffer, count) != ESP_OK) break;
      received += count; progress = received * 100 / c.size;
      vTaskDelay(1);
    }
    if (received != c.size || !esp_http_client_is_complete_data_received(http)) break;
    unsigned char digest[32]; char hex[65];
    if (mbedtls_sha256_finish(&sha, digest) != 0) break;
    for (int i = 0; i < 32; ++i) snprintf(hex + i*2, 3, "%02x", digest[i]);
    if (strcmp(hex, c.hash)) break;
    state = "verifying_image";
    esp_err_t end = esp_ota_end(handle); started = false;
    if (end != ESP_OK || esp_ota_set_boot_partition(destination) != ESP_OK) break;
    ok = true;
  } while (false);
  if (started) esp_ota_abort(handle);
  if (http) { if (opened) esp_http_client_close(http); esp_http_client_cleanup(http); }
  mbedtls_sha256_free(&sha);
  if (ok) {
    state = "rebooting";
    mqtt_publish_status(); delay(500); ESP.restart();
  }
  state = "failed"; busy = false;
  DiagnosticSerial.println("[OTA] Download/validation failed; active firmware unchanged");
  vTaskDelete(nullptr);
}

void setup_ota() {
  uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(device_id, sizeof(device_id), "GrowboxESP32_%02X%02X%02X%02X%02X%02X", mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
  destination = esp_ota_get_next_update_partition(nullptr);
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t image_state;
  verifying = esp_ota_get_state_partition(running, &image_state) == ESP_OK && image_state == ESP_OTA_IMG_PENDING_VERIFY;
  boot_ms = millis();
  commands = xQueueCreate(1, sizeof(Command));
  ready = OTA_ENABLED && strlen(OTA_PUBLIC_KEY_PEM) > 0 && strlen(OTA_DOWNLOAD_TOKEN) >= 32 && valid_url(OTA_FIRMWARE_BASE_URL) &&
      rollback_enabled() && destination && destination != running && commands;
  state = verifying ? "boot_verification" : (ready ? "idle" : "disabled");
  DiagnosticSerial.printf("[OTA] ready=%d rollback=%d next_slot=%u\n", ready, rollback_enabled(), destination ? (unsigned)destination->size : 0);
}

void process_ota() {
  if (verifying) {
    if (millis() - boot_ms > 60000 && mqtt_is_connected()) {
      if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) { verifying = false; state = ready ? "idle" : "disabled"; }
    } else if (millis() - boot_ms > 180000) {
      ESP.restart(); // Bootloader rolls back the unconfirmed application.
    }
    return;
  }
  if (!ready || busy.load()) return;
  Command c;
  if (xQueueReceive(commands, &c, 0) != pdPASS) return;
  const time_t now = time(nullptr);
  if (now < 1704067200 || c.expires <= now || c.expires > now + 86400 || !signature_ok(c)) { state = "rejected"; return; }
  busy = true; // Prevent new relay ON commands and new camera work before checking idle.
  bool idle = !camera_upload_busy();
  for (int i = 1; i <= 6; ++i) if (get_relay(i)) idle = false;
  if (!idle || WiFi.status() != WL_CONNECTED) { busy = false; state = "not_idle"; return; }
  Command *job = new (std::nothrow) Command(c);
  progress = 0;
  if (!job || xTaskCreate(download_task, "https_ota", 16384, job, 1, nullptr) != pdPASS) {
    delete job; busy = false; state = "failed";
  }
}

bool ota_busy() { return busy.load() || verifying; }
void fill_ota_status(JsonObject object) {
  object["device_id"] = device_id;
  object["build"] = FIRMWARE_BUILD_NUMBER;
  object["model"] = "hzad-s3-n16r8";
  object["identity"] = identity;
  object["enabled"] = ready;
  object["rollback"] = rollback_enabled();
  object["state"] = state.load();
  object["progress"] = progress.load();
  object["slot_bytes"] = destination ? destination->size : 0;
}
