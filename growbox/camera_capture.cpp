#include "camera_capture.h"
#include "mqtt_transport.h"
#include "config.h"
#include "USB_STREAM.h"

// Buffers 650 KB for uncompressed 640x480/160x120 YUY2 in PSRAM
#define XFER_BUFFER_SIZE   (650 * 1024)
#define FRAME_BUFFER_SIZE  (650 * 1024)

static uint8_t *_xferBufferA = NULL;
static uint8_t *_xferBufferB = NULL;
static uint8_t *_frameBuffer = NULL;

static USB_STREAM *usb = NULL;

static volatile bool newFrameReady = false;
static volatile size_t lastFrameBytes = 0;
static volatile uint32_t lastWidth = 0;
static volatile uint32_t lastHeight = 0;

static unsigned long lastPhotoTime = 0;
static bool initialPhotoSent = false;

// Base64 encoding table
static const char base64_chars[] = 
             "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
             "abcdefghijklmnopqrstuvwxyz"
             "0123456789+/";

static String base64_encode(const uint8_t *in, size_t in_len) {
  String out;
  out.reserve(((in_len + 2) / 3) * 4);
  int val = 0, valb = -6;
  for (size_t i = 0; i < in_len; i++) {
    val = (val << 8) + in[i];
    valb += 8;
    while (valb >= 0) {
      out += base64_chars[(val >> valb) & 0x3F];
      valb -= 6;
    }
  }
  if (valb > -6) out += base64_chars[((val << 8) >> (valb + 8)) & 0x3F];
  while (out.length() % 4) out += '=';
  return out;
}

static volatile bool snapshot_capture_requested = false;
static volatile bool camera_upload_in_progress = false;

struct CameraFrameSnapshot {
  uint8_t* buffer;
  size_t bytes;
  uint32_t width;
  uint32_t height;
};

static void camera_upload_task(void *pvParameters) {
  CameraFrameSnapshot* snap = (CameraFrameSnapshot*)pvParameters;
  if (!snap) {
    camera_upload_in_progress = false;
    vTaskDelete(NULL);
    return;
  }

  uint32_t w = snap->width;
  uint32_t h = snap->height;
  size_t bytes = snap->bytes;

  Serial.printf("[CAMERA] Background upload task running on Core %d: encoding %u bytes (%ux%u). Free heap: %u\n",
                xPortGetCoreID(), (unsigned int)bytes, (unsigned int)w, (unsigned int)h,
                (unsigned int)ESP.getFreeHeap());

  String base64_img = base64_encode(snap->buffer, bytes);

  // Free the snapshot buffer as soon as base64 string is ready to conserve memory
  if (snap->buffer) {
    free(snap->buffer);
    snap->buffer = NULL;
  }
  delete snap;

  String json = "{\"format\":\"yuy2\",\"width\":" + String(w) + ",\"height\":" + String(h) + ",\"data\":\"" + base64_img + "\"}";

  Serial.printf("[CAMERA] Publishing payload (%u bytes) via MQTT in background task...\n", (unsigned int)json.length());
  mqtt_publish_image(json.c_str());

  camera_upload_in_progress = false;
  vTaskDelete(NULL);
}

static void cameraFrameCallback(uvc_frame_t *frame, void *ptr) {
  if (!frame || frame->data_bytes == 0) return;

  // Atomically capture frame when requested, while frame->data is stable and owned by driver callback
  if (snapshot_capture_requested && !camera_upload_in_progress) {
    snapshot_capture_requested = false;

    uint8_t* snap_buf = NULL;
    if (psramFound()) {
      snap_buf = (uint8_t*)heap_caps_malloc(frame->data_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    if (!snap_buf) {
      snap_buf = (uint8_t*)malloc(frame->data_bytes);
    }

    if (snap_buf) {
      memcpy(snap_buf, frame->data, frame->data_bytes);
      CameraFrameSnapshot* snap = new CameraFrameSnapshot{snap_buf, frame->data_bytes, frame->width, frame->height};
      camera_upload_in_progress = true;

      BaseType_t res = xTaskCreatePinnedToCore(
        camera_upload_task,
        "cam_upload",
        20 * 1024,
        (void*)snap,
        1, // Priority 1 (low background priority)
        NULL,
        0  // Core 0 (main Arduino loop runs on Core 1)
      );

      if (res != pdPASS) {
        Serial.println("[CAMERA ERR] Failed to create background upload task! Freeing snapshot.");
        if (snap_buf) free(snap_buf);
        delete snap;
        camera_upload_in_progress = false;
      } else {
        Serial.println("[CAMERA] Frame atomically captured in USB callback and dispatched to Core 0 task.");
      }
    } else {
      Serial.println("[CAMERA ERR] Out of memory allocating snapshot buffer in callback!");
    }
  }
}

static size_t actual_xfer_size = 0;
static size_t actual_frame_size = 0;

void setup_camera() {
  Serial.printf("[CAMERA] psramFound: %d, free_psram: %u, free_heap: %u\n", 
                psramFound(), (unsigned int)ESP.getFreePsram(), (unsigned int)ESP.getFreeHeap());

  if (psramFound()) {
    Serial.println("[CAMERA] PSRAM detected. Allocating 64KB buffers in PSRAM...");
    actual_xfer_size = 64 * 1024;
    actual_frame_size = 64 * 1024;
    _xferBufferA = (uint8_t *)heap_caps_malloc(actual_xfer_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    _xferBufferB = (uint8_t *)heap_caps_malloc(actual_xfer_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    _frameBuffer = (uint8_t *)heap_caps_malloc(actual_frame_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }

  if (!_xferBufferA || !_xferBufferB || !_frameBuffer) {
    if (_xferBufferA) { free(_xferBufferA); _xferBufferA = NULL; }
    if (_xferBufferB) { free(_xferBufferB); _xferBufferB = NULL; }
    if (_frameBuffer) { free(_frameBuffer); _frameBuffer = NULL; }

    Serial.println("[CAMERA] Allocating compact 16KB/40KB buffers in SRAM (160x120 YUY2)...");
    actual_xfer_size = 16 * 1024;
    actual_frame_size = 40 * 1024;
    _xferBufferA = (uint8_t *)malloc(actual_xfer_size);
    _xferBufferB = (uint8_t *)malloc(actual_xfer_size);
    _frameBuffer = (uint8_t *)malloc(actual_frame_size);
  }

  if (!_xferBufferA || !_xferBufferB || !_frameBuffer) {
    Serial.println("[CAMERA ERR] Buffer allocation failed!");
    return;
  }
  Serial.printf("[CAMERA OK] Buffers allocated: xfer=%u, frame=%u\n", (unsigned int)actual_xfer_size, (unsigned int)actual_frame_size);

  usb = new USB_STREAM();
  usb->uvcCamRegisterCb(cameraFrameCallback, NULL);

  usb->uvcConfiguration(
    160,
    120,
    FRAME_INTERVAL_FPS_10,
    actual_xfer_size,
    _xferBufferA,
    _xferBufferB,
    actual_frame_size,
    _frameBuffer
  );

  Serial.println("[CAMERA] Starting USB Host stream...");
  usb->start();
  usb->connectWait(3000);
  Serial.println("[CAMERA OK] USB Stream started, waiting for frames...");
  lastPhotoTime = millis();
}

static volatile bool forceCapture = false;
static unsigned long forceCaptureStartTime = 0;

void trigger_camera_capture() {
  forceCapture = true;
  forceCaptureStartTime = millis();
  Serial.println("[CAMERA] On-demand capture requested via MQTT!");
}

void process_camera() {
  unsigned long now = millis();

  // Send photo on request, after 15 seconds from boot, or every CAMERA_INTERVAL (10 min)
  bool shouldSend = false;
  if (forceCapture) {
    shouldSend = true;
  } else if (!initialPhotoSent && now > 15000) {
    shouldSend = true;
  } else if (now - lastPhotoTime >= CAMERA_INTERVAL) {
    shouldSend = true;
  }

  if (shouldSend) {
    if (camera_upload_in_progress) {
      Serial.println("[CAMERA] Background upload still in progress, waiting...");
      return;
    }
    forceCapture = false;
    initialPhotoSent = true;
    lastPhotoTime = now;
    snapshot_capture_requested = true;
    Serial.println("[CAMERA] Snapshot requested: will capture next complete frame inside USB callback.");
  }
}
