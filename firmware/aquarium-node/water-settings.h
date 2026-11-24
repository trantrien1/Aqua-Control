#pragma once
#include <Preferences.h>
#include <ArduinoJson.h>
#include "water-change.h"

namespace WaterSettings {
Preferences store;
bool ready = false;
int lastGuard = -1;
bool parse(JsonVariantConst input, WaterChange::Config &cfg) {
  if (!input["revision"].is<uint32_t>() || !input["autoEnabled"].is<bool>()) return false;
  cfg.revision = input["revision"].as<uint32_t>();
  if (input["tankLiters"].isNull() && input["autoEnabled"].as<bool>() == false) cfg.tankLiters = 0;
  else {
    if (!input["tankLiters"].is<float>()) return false;
    cfg.tankLiters = input["tankLiters"].as<float>();
    if (!isfinite(cfg.tankLiters) || cfg.tankLiters < 1 || cfg.tankLiters > 500) return false;
  }
  cfg.autoEnabled = input["autoEnabled"].as<bool>();
  if (!input["lighting"].isNull()) {
    const JsonVariantConst light = input["lighting"];
    if (!light["scheduleEnabled"].is<bool>() || !light["heatEnabled"].is<bool>() ||
        !light["onMinute"].is<int>() || !light["offMinute"].is<int>() ||
        !light["utcOffsetMinutes"].is<int>() || !light["heatOn"].is<float>() || !light["heatOff"].is<float>()) return false;
    const int on = light["onMinute"], off = light["offMinute"], offset = light["utcOffsetMinutes"];
    const float low = light["heatOn"], high = light["heatOff"];
    if (on < 0 || on > 1439 || off < 0 || off > 1439 || on == off || offset < -720 || offset > 840 ||
        !isfinite(low) || !isfinite(high) || low < 0 || high > 40 || high - low < .1f - .00001f) return false;
    cfg.lighting.scheduleEnabled = light["scheduleEnabled"];
    cfg.lighting.heatEnabled = light["heatEnabled"];
    cfg.lighting.onMinute = on; cfg.lighting.offMinute = off; cfg.lighting.utcOffsetMinutes = offset;
    cfg.lighting.heatOn = low; cfg.lighting.heatOff = high;
  }
  cfg.turbidityPercent = input["thresholds"]["turbidity_percent"].is<JsonObjectConst>();
  const char *keys[] = {"temperature", "ph", "tds", cfg.turbidityPercent ? "turbidity_percent" : "turbidity_voltage"};
  const float lows[] = {-55, 0, 0, 0};
  const float highs[] = {125, 14, 5000, cfg.turbidityPercent ? 100.0f : 6.6f};
  for (uint8_t i = 0; i < 4; ++i) {
    JsonVariantConst r = input["thresholds"][keys[i]];
    if (i == 3 && r.is<JsonObjectConst>() && r["min"].isNull() && r["max"].isNull()) {
      cfg.ranges[i] = {0, 0, false}; continue;
    }
    if (!r["min"].is<float>() || !r["max"].is<float>()) return false;
    const float lo = r["min"].as<float>(), hi = r["max"].as<float>();
    if (!isfinite(lo) || !isfinite(hi) || lo < lows[i] || hi > highs[i] || lo >= hi) return false;
    cfg.ranges[i] = {lo, hi, true};
  }
  return true;
}
void begin(WaterChange::Controller &controller) {
  ready = store.begin("aqua-water", false);
  if (!ready) { controller.stage = WaterChange::Stage::Error; controller.reason = "storage-error"; return; }
  JsonDocument saved;
  WaterChange::Config cfg;
  if (!deserializeJson(saved, store.getString("config", "")) && parse(saved.as<JsonVariantConst>(), cfg)) controller.config = cfg;
  lastGuard = store.getUChar("guard", 0);
  // Versioned guard: bit 5 marks the new format, bit 6 preserves automatic origin.
  // Old interrupted guards have unknown origin and conservatively retain confirmation.
  controller.restoreGuard(lastGuard);
}
bool saveConfig(JsonVariantConst input, const WaterChange::Config &cfg, WaterChange::Controller &controller) {
  if (!ready || controller.active() || cfg.revision < controller.config.revision) return false;
  if (cfg.revision == controller.config.revision) return true; // Retained duplicate: no flash write.
  String value;
  serializeJson(input, value);
  if (store.putString("config", value) != value.length()) return false;
  controller.config = cfg;
  return true;
}
bool guard(WaterChange::Controller &controller) {
  // Keep Error latched across reboots until the operator checks and resets water level.
  const uint8_t value = controller.guardValue();
  if (lastGuard == value) return true;
  if (!ready || store.putUChar("guard", value) != 1) {
    controller.stage = WaterChange::Stage::Error; controller.reason = "storage-error"; return false;
  }
  lastGuard = value;
  return true;
}
}
