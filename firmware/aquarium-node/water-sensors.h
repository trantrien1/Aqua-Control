#pragma once

// Measurement logic from ESP32_Water_test.ino. Keep the same wiring and NVS keys.
#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include <math.h>

namespace WaterSensors {
constexpr uint8_t PIN_PH = 34;
constexpr uint8_t PIN_TURBIDITY = 35;
constexpr uint8_t PIN_TDS = 32;
constexpr uint8_t PIN_TEMPERATURE = 27;
constexpr bool ENABLE_TURBIDITY = true;
constexpr float DIVIDER_GAIN = 2.0f;
constexpr float TDS_FACTOR = 1.0f;

OneWire oneWire(PIN_TEMPERATURE);
DallasTemperature temperatureSensor(&oneWire);
Preferences settings;
bool storageOK = false;
float ph7V = NAN;
float ph4V = NAN;
String command;

struct Reading {
  float temperature = NAN;
  float ph = NAN;
  float tds = NAN;
  float turbidityVoltage = NAN;  // Module OUT, before the 10k/10k divider.
  float phADC = NAN;
  float tdsADC = NAN;
  float turbidityADC = NAN;
  bool phCalibrated = false;
  bool tdsTemperatureFallback = false;
};

float readVoltage(uint8_t pin) {
  constexpr uint8_t COUNT = 31;
  uint32_t samples[COUNT];
  (void)analogReadMilliVolts(pin);
  delay(2);
  for (uint8_t i = 0; i < COUNT; ++i) {
    samples[i] = analogReadMilliVolts(pin);
    delay(3);
  }
  for (uint8_t i = 1; i < COUNT; ++i) {
    const uint32_t value = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > value) {
      samples[j + 1] = samples[j];
      --j;
    }
    samples[j + 1] = value;
  }
  return samples[COUNT / 2] / 1000.0f;
}

bool phCalibrationReady() {
  return isfinite(ph7V) && isfinite(ph4V) && fabsf(ph4V - ph7V) > 0.02f;
}

void printHelp() {
  Serial.println("Lenh Serial (115200 baud, Newline): ph7 | ph4 | resetph | help");
  Serial.println("Nhung dau do vao dung dich CHUAN pH 7 / pH 4, cho on dinh roi gui lenh tuong ung.");
  Serial.println("Khong dung nuoc may/nuoc loc thay cho dung dich chuan pH.");
}

void executeCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd == "help") {
    printHelp();
  } else if (cmd == "resetph") {
    ph7V = NAN;
    ph4V = NAN;
    if (storageOK) {
      settings.remove("ph7v");
      settings.remove("ph4v");
    }
    Serial.println("Da xoa hieu chuan pH.");
  } else if (cmd == "ph7" || cmd == "ph4") {
    const float voltage = readVoltage(PIN_PH);
    if (voltage < 0.15f || voltage > 2.60f) {
      Serial.println("Tu choi: dien ap pH ngoai vung thu. Kiem tra dau do/chia ap.");
      return;
    }
    if (cmd == "ph7") ph7V = voltage;
    else ph4V = voltage;
    const size_t saved = storageOK ? settings.putFloat(cmd == "ph7" ? "ph7v" : "ph4v", voltage) : 0;
    Serial.printf("%s: Vadc=%.3f V; %s\n", cmd.c_str(), voltage,
                  saved == sizeof(float) ? "da luu vao ESP32" : "chi luu RAM, se mat khi reset");
    Serial.println(phCalibrationReady() ? "Da co 2 diem pH. Khong van bien tro sau hieu chuan."
                                       : "Can diem con lai; hai dien ap phai khac nhau > 0.02 V.");
  } else if (cmd.length()) {
    Serial.println("Lenh khong dung. Gui help.");
  }
}

void readCommands() {
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r' || c == '\n') {
      if (command.length()) {
        executeCommand(command);
        command = "";
      }
    } else if (command.length() < 48) {
      command += c;
    }
  }
}

void begin() {
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_PH, ADC_11db);
  analogSetPinAttenuation(PIN_TDS, ADC_11db);
  pinMode(PIN_PH, INPUT);
  pinMode(PIN_TDS, INPUT);
  if (ENABLE_TURBIDITY) {
    analogSetPinAttenuation(PIN_TURBIDITY, ADC_11db);
    pinMode(PIN_TURBIDITY, INPUT);
  }
  temperatureSensor.begin();
  temperatureSensor.setResolution(12);
  temperatureSensor.setWaitForConversion(true);
  storageOK = settings.begin("water-test", false);
  if (storageOK) {
    ph7V = settings.getFloat("ph7v", NAN);
    ph4V = settings.getFloat("ph4v", NAN);
  }
  Serial.printf("DS18B20 tim thay: %u\n", static_cast<unsigned>(temperatureSensor.getDeviceCount()));
  Serial.println("pH=34 | TDS=32 | TURB=35 | DS18B20=27");
  Serial.println("TDS: UOC TINH, chua hieu chuan. Do duc: dien ap OUT, chua quy doi NTU.");
  if (!storageOK) Serial.println("Luu y: khong mo duoc bo nho luu hieu chuan.");
  printHelp();
}

Reading read() {
  Reading result;
  temperatureSensor.requestTemperatures();
  const float tempC = temperatureSensor.getTempCByIndex(0);
  const bool tempOK = isfinite(tempC) && tempC != DEVICE_DISCONNECTED_C && tempC >= -55.0f && tempC <= 125.0f;
  if (tempOK) result.temperature = tempC;
  result.phADC = readVoltage(PIN_PH);
  result.tdsADC = readVoltage(PIN_TDS);
  result.phCalibrated = phCalibrationReady();

  if (result.phCalibrated && result.phADC >= 0.15f && result.phADC <= 2.60f) {
    const float ph = 7.0f - 3.0f * (result.phADC - ph7V) / (ph4V - ph7V);
    if (ph >= 0.0f && ph <= 14.0f) result.ph = ph;
  }
  if (result.tdsADC >= 0.15f && result.tdsADC <= 2.40f && (!tempOK || (tempC >= 0.0f && tempC <= 55.0f))) {
    const float compensationTemp = tempOK ? tempC : 25.0f;
    const float v25 = result.tdsADC / (1.0f + 0.02f * (compensationTemp - 25.0f));
    result.tds = (133.42f * v25 * v25 * v25 - 255.86f * v25 * v25 + 857.39f * v25) * 0.5f * TDS_FACTOR;
    result.tdsTemperatureFallback = !tempOK;
  }
  if (ENABLE_TURBIDITY) {
    result.turbidityADC = readVoltage(PIN_TURBIDITY);
    if (result.turbidityADC <= 2.60f) result.turbidityVoltage = result.turbidityADC * DIVIDER_GAIN;
  }
  Serial.printf("TEMP=%.2f C | pH=%.2f (ADC %.3f V) | TDS~%.0f ppm (ADC %.3f V) | TURB OUT~%.3f V\n",
                result.temperature, result.ph, result.phADC, result.tds, result.tdsADC, result.turbidityVoltage);
  if (!result.phCalibrated) Serial.println("PH: CHUA HIEU CHUAN. Gui ph7 va ph4.");
  if (!tempOK) Serial.println("TEMP: LOI / khong tim thay DS18B20; TDS tam bu nhiet 25 C.");
  if (result.tds > 1000.0f) Serial.println("TDS: vuot dai 0-1000 ppm cua mo hinh tham chieu.");
  if (result.phADC > 2.60f || result.turbidityADC > 2.60f) Serial.println("CANH BAO: kiem tra mach chia ap.");
  return result;
}
}  // namespace WaterSensors
