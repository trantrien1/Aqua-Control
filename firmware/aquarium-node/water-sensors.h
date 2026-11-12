#pragma once

// Measurement logic from ESP32_Water_test.ino. Keep the same wiring and NVS keys.
#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include <math.h>
#include "sensor-estimates.h"

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
uint32_t lastTemperatureSearchMs = 0;
uint16_t temperatureDevices = 0;

void rescanTemperature() {
  temperatureSensor.begin();
  temperatureSensor.setResolution(12);
  temperatureSensor.setWaitForConversion(true);
  temperatureDevices = temperatureSensor.getDeviceCount();
  lastTemperatureSearchMs = millis();
}

struct Reading {
  float temperature = NAN;
  float ph = NAN;
  float tds = NAN;
  float turbidityVoltage = NAN;  // Module OUT, before the 10k/10k divider.
  float turbidityPercent = NAN;
  float phADC = NAN;
  float tdsADC = NAN;
  float turbidityADC = NAN;
  bool phCalibrated = false;
  bool phEstimated = false;
  bool phFixedReference = false;
  float phReferenceADC = NAN;
  float turbidityReferenceVoltage = NAN;
  float turbidityChangePercent = NAN;
  bool tdsTemperatureFallback = false;
  bool temperatureDetected = false;
  uint16_t temperatureDeviceCount = 0;
  const char *phStatus = "no-data";
  const char *tdsStatus = "no-data";
  const char *turbidityStatus = "no-data";
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
  return !SensorEstimates::FIXED_REFERENCE_MODE && isfinite(ph7V) && isfinite(ph4V) && fabsf(ph4V - ph7V) > 0.02f;
}

void printHelp() {
  if (SensorEstimates::FIXED_REFERENCE_MODE) {
    Serial.println("pH: moc nuoc may ADC 1.927 V -> pH 7.00. Nuoc trong: OUT 3.272 V -> 0% duc tuong doi.");
    Serial.println("Khong can gui ph7/ph4. So do tiep tuc cap nhat va xu ly nguong binh thuong.");
    Serial.println("Che do hai diem tuy chon: doi FIXED_REFERENCE_MODE=false trong sensor-estimates.h.");
  } else {
    Serial.println("Hieu chuan hai diem: ph7 | ph4 | resetph. Dung dung dich chuan tuong ung.");
  }
}

void executeCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd == "help") {
    printHelp();
  } else if (cmd == "resetapprox") {
    Serial.println("Moc hien tai co dinh trong code; khoi dong lai khong thay doi.");
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
  rescanTemperature();
  storageOK = settings.begin("water-test", false);
  if (storageOK) {
    // Fixed-reference mode does not require these optional two-point calibration keys.
    if (settings.isKey("ph7v")) ph7V = settings.getFloat("ph7v", NAN);
    if (settings.isKey("ph4v")) ph4V = settings.getFloat("ph4v", NAN);
  }
  Serial.printf("DS18B20 tim thay: %u\n", static_cast<unsigned>(temperatureSensor.getDeviceCount()));
  Serial.println("pH=34 | TDS=32 | TURB=35 | DS18B20=27");
  Serial.println("TDS: bu nhiet DS18B20. Do duc: dien ap OUT (V).");
  if (!storageOK) Serial.println("Luu y: khong mo duoc bo nho luu hieu chuan.");
  printHelp();
}

Reading read() {
  Reading result;
  if (temperatureDevices == 0 && millis() - lastTemperatureSearchMs >= 10000) rescanTemperature();
  temperatureSensor.requestTemperatures();
  const float tempC = temperatureSensor.getTempCByIndex(0);
  const bool tempOK = isfinite(tempC) && tempC != DEVICE_DISCONNECTED_C && tempC >= -55.0f && tempC <= 125.0f;
  result.temperatureDetected = tempOK;
  result.temperatureDeviceCount = temperatureDevices;
  result.tdsTemperatureFallback = !tempOK;
  if (!tempOK && temperatureDevices > 0) temperatureDevices = 0; // Allow recovery after a transient bus loss.
  if (tempOK) result.temperature = tempC;
  result.phADC = readVoltage(PIN_PH);
  result.tdsADC = readVoltage(PIN_TDS);
  if (ENABLE_TURBIDITY) result.turbidityADC = readVoltage(PIN_TURBIDITY);
  result.phCalibrated = phCalibrationReady();
  result.phFixedReference = SensorEstimates::FIXED_REFERENCE_MODE;

  if (result.phFixedReference) {
    result.ph = SensorEstimates::ph(result.phADC, SensorEstimates::PH_REFERENCE_ADC);
    result.phEstimated = isfinite(result.ph); // Preserve provenance without changing the requested display.
    result.phReferenceADC = SensorEstimates::PH_REFERENCE_ADC;
  } else if (result.phCalibrated && result.phADC >= 0.15f && result.phADC <= 2.60f) {
    const float ph = 7.0f - 3.0f * (result.phADC - ph7V) / (ph4V - ph7V);
    if (ph >= 0.0f && ph <= 14.0f) result.ph = ph;
  }
  result.phStatus = isfinite(result.ph) ? (result.phEstimated ? "estimated" : "calibrated")
    : !SensorEstimates::validADC(result.phADC) ? "adc-outside-reference-range"
    : !result.phFixedReference && !result.phCalibrated ? "not-calibrated" : "outside-ph-domain";
  if (result.tdsADC >= 0.15f && result.tdsADC <= 2.40f && (!tempOK || (tempC >= 0.0f && tempC <= 55.0f))) {
    const float compensationTemp = tempOK ? tempC : 25.0f;
    const float v25 = result.tdsADC / (1.0f + 0.02f * (compensationTemp - 25.0f));
    result.tds = (133.42f * v25 * v25 * v25 - 255.86f * v25 * v25 + 857.39f * v25) * 0.5f * TDS_FACTOR;
    result.tdsTemperatureFallback = !tempOK;
  }
  result.tdsStatus = isfinite(result.tds) ? (tempOK ? "estimated" : "estimated-at-25C")
    : result.tdsADC < 0.15f || result.tdsADC > 2.40f ? "adc-outside-reference-range" : "temperature-outside-model";
  if (ENABLE_TURBIDITY) {
    if (result.turbidityADC <= 2.60f) result.turbidityVoltage = result.turbidityADC * DIVIDER_GAIN;
    result.turbidityPercent = SensorEstimates::turbidityPercent(result.turbidityVoltage);
    if (SensorEstimates::FIXED_REFERENCE_MODE) {
      result.turbidityReferenceVoltage = SensorEstimates::TURBIDITY_REFERENCE_OUT;
      result.turbidityChangePercent = SensorEstimates::voltageChangePercent(result.turbidityADC, SensorEstimates::TURBIDITY_REFERENCE_OUT / DIVIDER_GAIN);
    }
  }
  result.turbidityStatus = isfinite(result.turbidityPercent) ? "relative-percent" : "adc-outside-reference-range";
  const char *clarity = !isfinite(result.turbidityPercent) ? "LOI" : result.turbidityPercent <= 5 ? "TRONG" : result.turbidityPercent <= 20 ? "HOI DUC" : "DUC";
  Serial.printf("TEMP=%.2f C | pH=%.2f (ADC %.3f V) | TDS=%.0f ppm (ADC %.3f V) | DO DUC=%.1f%% (%s) | OUT=%.3f V\n",
                result.temperature, result.ph, result.phADC, result.tds, result.tdsADC, result.turbidityPercent, clarity, result.turbidityVoltage);
  if (!result.phFixedReference && !result.phCalibrated) Serial.println("PH: CHUA HIEU CHUAN. Gui ph7 va ph4.");
  if (!tempOK) Serial.printf("[sensor] DS18B20 GPIO%u: chua co nhiet do hop le, raw=%.2f C, devices=%u. Se do lai; TDS chi bu 25 C khi ADC hop le.\n", PIN_TEMPERATURE, tempC, result.temperatureDeviceCount);
  if (result.tds > 1000.0f) Serial.println("TDS: vuot dai 0-1000 ppm cua mo hinh tham chieu.");
  if (!isfinite(result.ph) || !isfinite(result.tds) || !isfinite(result.turbidityPercent)) {
    Serial.printf("[sensor] Chua quy doi: PH=%s, TDS=%s, TURB=%s. Day la gioi han cua mo hinh, khong ket luan mach hong.\n", result.phStatus, result.tdsStatus, result.turbidityStatus);
  }
  return result;
}
}  // namespace WaterSensors
