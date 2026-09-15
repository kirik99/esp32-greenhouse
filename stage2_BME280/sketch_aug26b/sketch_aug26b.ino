void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println("================================");
  Serial.println("ESP32-S3 TEST");
  Serial.println("ESP32 работает!");
  Serial.println("================================");
}

void loop() {
  Serial.println("RUNNING");
  delay(1000);
}