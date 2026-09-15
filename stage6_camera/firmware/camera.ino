#include <Arduino.h>
#include "USB_STREAM.h"

// Буферы 650 КБ под несжатый кадр 640x480 YUY2 (614 400 байт)
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
volatile uint32_t totalFramesReceived = 0;

uint32_t lastPhotoTime = 0;
uint32_t lastHeartbeatTime = 0;
const uint32_t PHOTO_INTERVAL_MS = 600000; // Фото каждые 10 минут

void logMsg(const char *msg) {
  Serial.println(msg);
  Serial0.println(msg);
  printf("%s\n", msg);
  fflush(stdout);
}

void cameraFrameCallback(uvc_frame_t *frame, void *ptr) {
  if (frame && frame->data_bytes > 0) {
    lastFrameBytes = frame->data_bytes;
    lastWidth = frame->width;
    lastHeight = frame->height;
    totalFramesReceived++;
    newFrameReady = true;

    if (totalFramesReceived == 1) {
      printf("[CAMERA_OK] First frame received! %ux%u, %u bytes\n", 
             (unsigned int)frame->width, (unsigned int)frame->height, (unsigned int)frame->data_bytes);
      fflush(stdout);
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial0.begin(115200);
  delay(1500);

  logMsg("\n--- ESP32-S3 USB Camera Starting ---");

  // Выделяем буферы в PSRAM
  _xferBufferA = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _xferBufferB = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _frameBuffer = (uint8_t *)heap_caps_malloc(FRAME_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

  if (!_xferBufferA || !_xferBufferB || !_frameBuffer) {
    logMsg("[ERR] PSRAM allocation failed!");
    return;
  }
  logMsg("[OK] PSRAM buffers allocated (650KB each)");

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

  logMsg("[INFO] Starting USB Host...");
  usb->start();
  usb->connectWait(5000);
  logMsg("[OK] USB Stream started! Waiting for camera frames...");
  lastPhotoTime = millis();
}

void sendFramePacket(const uint8_t *buf, size_t len, uint32_t w, uint32_t h) {
  char header[64];
  int hlen = snprintf(header, sizeof(header), "[IMG_START:%u:%u:%u]\n", (unsigned int)len, (unsigned int)w, (unsigned int)h);
  
  // Отправляем через Serial0 (аппаратный UART0 / COM5)
  Serial0.write((const uint8_t *)header, hlen);
  Serial0.write(buf, len);
  Serial0.write((const uint8_t *)"\n[IMG_END]\n", 11);
  Serial0.flush();

  // Дублируем через Serial и stdout для 100% совместимости
  Serial.write((const uint8_t *)header, hlen);
  Serial.write(buf, len);
  Serial.write((const uint8_t *)"\n[IMG_END]\n", 11);
  Serial.flush();
}

void loop() {
  uint32_t currentMillis = millis();

  // Логирование статуса каждые 3 секунды
  if (currentMillis - lastHeartbeatTime >= 3000) {
    lastHeartbeatTime = currentMillis;
    char statBuf[96];
    snprintf(statBuf, sizeof(statBuf), "[STATUS] UVC stream active. Total frames received: %u", (unsigned int)totalFramesReceived);
    logMsg(statBuf);
  }

  // Каждые 10 секунд передаём кадр на ПК
  if (currentMillis - lastPhotoTime >= PHOTO_INTERVAL_MS) {
    lastPhotoTime = currentMillis;

    if (newFrameReady && lastFrameBytes > 0) {
      newFrameReady = false;

      char sendInfo[80];
      snprintf(sendInfo, sizeof(sendInfo), "[SENDING] Frame %u bytes (%ux%u)...", (unsigned int)lastFrameBytes, (unsigned int)lastWidth, (unsigned int)lastHeight);
      logMsg(sendInfo);

      sendFramePacket(_frameBuffer, lastFrameBytes, lastWidth, lastHeight);

      logMsg("[SENT] Frame sent to PC successfully!");
    } else {
      logMsg("[WAIT] Waiting for new frame from camera...");
    }
  }
}