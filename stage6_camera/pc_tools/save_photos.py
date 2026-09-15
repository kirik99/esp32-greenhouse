import serial
import serial.tools.list_ports
import os
import sys
import time
from datetime import datetime
import numpy as np
import cv2

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

def find_port():
    ports = list(serial.tools.list_ports.comports())
    for p in ports:
        desc = p.description or ""
        if any(k in desc for k in ['ESP', 'USB', 'MatrixPortal', 'CH340', 'CP210', 'Serial']):
            return p.device
    return 'COM5'

PORT = find_port()
BAUD = 115200

SAVE_FOLDER = os.path.join(os.path.expanduser('~'), 'Pictures', 'ESP32_Photos')
os.makedirs(SAVE_FOLDER, exist_ok=True)

print("=" * 65, flush=True)
print("       ESP32-S3 Photo Receiver & Auto-Saver", flush=True)
print(f"  Порт: {PORT} ({BAUD} baud)", flush=True)
print(f"  Папка сохранения: {SAVE_FOLDER}", flush=True)
print("=" * 65, flush=True)

try:
    ser = serial.Serial(PORT, BAUD, timeout=0.1)
    ser.setDTR(False)
    ser.setRTS(False)
except Exception as e:
    print(f"\n[ОШИБКА] Не удалось открыть порт {PORT}: {e}", flush=True)
    print("Убедитесь, что Монитор порта (Serial Monitor) в Arduino IDE ЗАКРЫТ.", flush=True)
    sys.exit(1)

print("✔ Порт успешно открыт! Ожидаем данные и фотографии с ESP32...\n", flush=True)

photo_idx = 1
buf = bytearray()

while True:
    try:
        n = ser.in_waiting
        if n > 0:
            chunk = ser.read(n)
            buf.extend(chunk)

        # 1. Проверяем наличие маркера начала кадра
        start_pos = buf.find(b'[IMG_START:')
        if start_pos != -1:
            # Если перед маркером был обычный текст/логи, выводим его
            if start_pos > 0:
                pre_text = buf[:start_pos].decode('utf-8', errors='ignore')
                for line in pre_text.splitlines():
                    line = line.strip()
                    if line:
                        print(f"  [ESP32]: {line}", flush=True)
                buf = buf[start_pos:]
                start_pos = 0

            # Ищем закрывающую скобку заголовка ']'
            end_header = buf.find(b']')
            if end_header != -1:
                header_str = buf[11:end_header].decode('utf-8', errors='ignore')
                parts = header_str.split(':')
                try:
                    expected_size = int(parts[0])
                    width = int(parts[1]) if len(parts) > 1 and int(parts[1]) > 0 else 640
                    height = int(parts[2]) if len(parts) > 2 and int(parts[2]) > 0 else 480
                except:
                    expected_size = 0
                    width, height = 640, 480

                # Тело кадра начинается сразу после ']\n' или ']'
                payload_start = end_header + 1
                if payload_start < len(buf) and buf[payload_start] == ord('\n'):
                    payload_start += 1

                # Проверяем, накопился ли весь кадр
                if len(buf) >= payload_start + expected_size:
                    raw_data = bytes(buf[payload_start:payload_start + expected_size])

                    # Ищем маркер конца кадра
                    end_marker = buf.find(b'[IMG_END]', payload_start + expected_size)
                    if end_marker != -1:
                        buf = buf[end_marker + 9:]
                    else:
                        buf = buf[payload_start + expected_size:]

                    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                    filename = os.path.join(SAVE_FOLDER, f"photo_{timestamp}_{photo_idx}.jpg")

                    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] 📸 Получен кадр #{photo_idx} ({len(raw_data)} байт, {width}x{height})!", flush=True)

                    # Конвертация и сохранение
                    if raw_data.startswith(b'\xff\xd8'):
                        with open(filename, 'wb') as f:
                            f.write(raw_data)
                        print(f"  ✔ Сохранён JPEG: {filename}\n", flush=True)
                    else:
                        try:
                            req_len = width * height * 2
                            yuy2_buf = raw_data[:req_len]
                            if len(yuy2_buf) < req_len:
                                yuy2_buf += b'\x00' * (req_len - len(yuy2_buf))
                            
                            yuy2_mat = np.frombuffer(yuy2_buf, dtype=np.uint8).reshape((height, width, 2))
                            bgr_mat = cv2.cvtColor(yuy2_mat, cv2.COLOR_YUV2BGR_YUY2)
                            cv2.imwrite(filename, bgr_mat)
                            print(f"  ✔ Сохранён JPG (из YUY2 {width}x{height}): {filename}\n", flush=True)
                        except Exception as ex:
                            raw_path = os.path.join(SAVE_FOLDER, f"photo_{timestamp}_{photo_idx}.raw")
                            with open(raw_path, 'wb') as f:
                                f.write(raw_data)
                            print(f"  ⚠ Сохранён RAW (ошибка декодирования: {ex}): {raw_path}\n", flush=True)

                    photo_idx += 1
                    continue
        else:
            # Обычный текстовый вывод от ESP32
            nl_pos = buf.find(b'\n')
            if nl_pos != -1:
                line = buf[:nl_pos].decode('utf-8', errors='ignore').strip()
                buf = buf[nl_pos + 1:]
                if line:
                    print(f"  [ESP32]: {line}", flush=True)
            elif len(buf) > 3000000:
                buf.clear()

        time.sleep(0.01)

    except KeyboardInterrupt:
        print("\nОстановка скрипта пользователем.", flush=True)
        break
    except Exception as e:
        print(f"Ошибка чтения: {e}", flush=True)
        time.sleep(0.5)

ser.close()
