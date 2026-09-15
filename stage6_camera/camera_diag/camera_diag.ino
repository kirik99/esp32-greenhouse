// =========================================================================
// ДИАГНОСТИЧЕСКИЙ СКЕТЧ: ПРОВЕРКА PSRAM И UVC ДЕСКРИПТОРОВ КАМЕРЫ
// Не заменяет основной camera.ino! Служит только для сбора характеристик.
// =========================================================================

#include <Arduino.h>
#include "USB_STREAM.h"

#define XFER_BUFFER_SIZE   (650 * 1024)
#define FRAME_BUFFER_SIZE  (650 * 1024)

static uint8_t *_xferBufferA = NULL;
static uint8_t *_xferBufferB = NULL;
static uint8_t *_frameBuffer = NULL;

USB_STREAM *usb = NULL;

void printLog(const char *msg) {
  Serial.println(msg);
  Serial0.println(msg);
  printf("%s\n", msg);
  fflush(stdout);
}

void diagFrameCallback(uvc_frame_t *frame, void *ptr) {
  if (frame && frame->data_bytes > 0) {
    char buf[128];
    snprintf(buf, sizeof(buf), "[DIAG_FRAME] Got frame: %u x %u, %u bytes",
             (unsigned int)frame->width, (unsigned int)frame->height, (unsigned int)frame->data_bytes);
    printLog(buf);
  }
}

void setup() {
  Serial.begin(115200);
  Serial0.begin(115200);
  delay(1500);

  printLog("\n=======================================================");
  printLog("        ESP32-S3 CAMERA & HARDWARE DIAGNOSTIC");
  printLog("=======================================================");

  // 1. Проверка PSRAM
  size_t totalPsram = ESP.getPsramSize();
  size_t freePsram = ESP.getFreePsram();

  char memInfo[128];
  snprintf(memInfo, sizeof(memInfo), "[PSRAM] Total: %u KB, Free: %u KB",
           (unsigned int)(totalPsram / 1024), (unsigned int)(freePsram / 1024));
  printLog(memInfo);

  if (totalPsram == 0) {
    printLog("[WARN] PSRAM is NOT detected! Check Tools -> PSRAM (try OPI vs QSPI).");
    printLog("[WARN] Attempting internal SRAM allocation for small probe...");
  } else {
    printLog("[OK] PSRAM detected successfully!");
  }

  // 2. Выделение буферов
  _xferBufferA = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _xferBufferB = (uint8_t *)heap_caps_malloc(XFER_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  _frameBuffer = (uint8_t *)heap_caps_malloc(FRAME_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

  if (!_xferBufferA || !_xferBufferB || !_frameBuffer) {
    printLog("[ERR] PSRAM buffer allocation failed! Trying smaller internal fallback for enumeration...");
    // Минимальные буферы во внутренней памяти, чтобы хотя бы перечислить дескрипторы камеры
    _xferBufferA = (uint8_t *)malloc(32 * 1024);
    _xferBufferB = (uint8_t *)malloc(32 * 1024);
    _frameBuffer = (uint8_t *)malloc(32 * 1024);
    if (!_xferBufferA || !_xferBufferB || !_frameBuffer) {
      printLog("[FATAL] Out of memory completely.");
      return;
    }
  } else {
    printLog("[OK] 650KB buffers allocated in PSRAM successfully.");
  }

  // 3. Запуск USB Host и опрос дескрипторов
  printLog("[INFO] Initializing USB Host & probing camera descriptors...");
  usb = new USB_STREAM();
  usb->uvcCamRegisterCb(diagFrameCallback, NULL);

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
  printLog("[INFO] Waiting for camera connection & descriptor dump...");
  usb->connectWait(5000);
  printLog("[INFO] Probing finished. If descriptors appeared above, see formats and resolutions.");
}

void loop() {
  delay(20000);
}
