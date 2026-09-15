#include <Arduino.h>
#include "USB_STREAM.h"

// Буферы 650 КБ под несжатый кадр 640x480 YUY2
#define XFER_BUFFER_SIZE   (650 * 1024)
#define FRAME_BUFFER_SIZE  (650 * 1024)

static uint8_t *_xferBufferA = NULL;
static uint8_t *_xferBufferB = NULL;
static uint8_t *_frameBuffer = NULL;

USB_STREAM *usb = NULL;

volatile bool newFrameReady = false;
volatile size_t lastFrameBytes = 0;
volatile uint32_t lastWidth = 0;
volatile uint32_t lastHeight = 0;

uint32_t lastPhotoTime = 0;
const uint32_t PHOTO_INTERVAL_MS = 10000; // 10 секунд

void cameraFrameCallback(uvc_frame_t *frame, void *ptr) {
  if (frame && frame->data_bytes > 0) {
    lastFrameBytes = frame->data_bytes;
    lastWidth = frame->width;
    lastHeight = frame->height;
    newFrameReady = true;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  // Выделяем буферы в PSRAM
  _xferBufferA = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _xferBufferB = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _frameBuffer = (uint8_t *)heap_caps_malloc(FRAME_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

  if (!_xferBufferA || !_xferBufferB || !_frameBuffer) {
    Serial.println("ERR: PSRAM alloc failed");
    return;
  }

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

  usb->start();
  usb->connectWait(5000);
}

void loop() {
  uint32_t currentMillis = millis();

  if (currentMillis - lastPhotoTime >= PHOTO_INTERVAL_MS) {
    lastPhotoTime = currentMillis;

    if (newFrameReady && lastFrameBytes > 0) {
      newFrameReady = false;

      // Отправляем пакет фото в COM-порт
      Serial.printf("[IMG_START:%u:%u:%u]\n", (unsigned int)lastFrameBytes, (unsigned int)lastWidth, (unsigned int)lastHeight);
      Serial.flush();

      Serial.write(_frameBuffer, lastFrameBytes);
      Serial.flush();

      Serial.println("\n[IMG_END]");
      Serial.flush();
    }
  }
}