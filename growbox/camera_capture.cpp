#include "camera_capture.h"
#include "mqtt_client.h"
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

static void cameraFrameCallback(uvc_frame_t *frame, void *ptr) {
  if (frame && frame->data_bytes > 0) {
    lastFrameBytes = frame->data_bytes;
    lastWidth = frame->width;
    lastHeight = frame->height;
    newFrameReady = true;
  }
}

void setup_camera() {
  Serial.println("[CAMERA] Allocating PSRAM buffers (650KB each)...");

  _xferBufferA = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _xferBufferB = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _frameBuffer = (uint8_t *)heap_caps_malloc(FRAME_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

  if (!_xferBufferA || !_xferBufferB || !_frameBuffer) {
    Serial.println("[CAMERA ERR] PSRAM allocation failed!");
    return;
  }
  Serial.println("[CAMERA OK] PSRAM buffers allocated successfully");

  usb = new USB_STREAM();
  usb->uvcCamRegisterCb(cameraFrameCallback, NULL);

  usb->uvcConfiguration(
    FRAME_RESOLUTION_ANY,
    FRAME_RESOLUTION_ANY,
    FRAME_INTERVAL_FPS_15,
    XFER_BUFFER_SIZE,
    _xferBufferA,
    _xferBufferB,
    FRAME_BUFFER_SIZE,
    _frameBuffer
  );

  Serial.println("[CAMERA] Starting USB Host stream...");
  usb->start();
  usb->connectWait(5000);
  Serial.println("[CAMERA OK] USB Stream started, waiting for frames...");
  lastPhotoTime = millis();
}

static volatile bool forceCapture = false;

void trigger_camera_capture() {
  forceCapture = true;
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

  if (shouldSend && newFrameReady && lastFrameBytes > 0) {
    newFrameReady = false;
    forceCapture = false;
    initialPhotoSent = true;
    lastPhotoTime = now;

    Serial.printf("[CAMERA] Preparing frame: %u bytes (%ux%u)...\n", 
                  (unsigned int)lastFrameBytes, (unsigned int)lastWidth, (unsigned int)lastHeight);

    String base64_img = base64_encode(_frameBuffer, lastFrameBytes);
    String json = "{\"format\":\"yuy2\",\"width\":" + String(lastWidth) + ",\"height\":" + String(lastHeight) + ",\"data\":\"" + base64_img + "\"}";
    
    mqtt_publish_image(json.c_str());
    Serial.println("[CAMERA] Frame published over MQTT!");
  }
}
