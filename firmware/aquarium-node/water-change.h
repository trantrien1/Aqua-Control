#pragma once
#include <stdint.h>
#include <math.h>
#include <string.h>

#if __cplusplus >= 201402L
#define WATER_CONSTEXPR constexpr
#else
#define WATER_CONSTEXPR
#endif

// Pure state machine: no MQTT, delay(), GPIO or wall clock. Also exercised on the host.
namespace WaterChange {
constexpr uint32_t SETTLE_MS = 60000;
constexpr uint32_t SWITCH_MS = 1000;
constexpr float FLOW_LPH = 96.0f;
struct Range { float min; float max; bool enabled; };
struct Config {
  uint32_t revision = 0;
  float tankLiters = 0;
  bool autoEnabled = false;
  bool turbidityPercent = false;
  Range ranges[4] = {{24, 28, true}, {6.8f, 8.2f, true}, {180, 280, true}, {0, 0, false}};
};
enum class Stage { Idle, Draining, Switching, Filling, Settling, Locked, Error };
class Controller {
public:
  Config config;
  Stage stage = Stage::Idle;
  uint8_t attempts = 0;
  uint8_t percent = 0;
  bool automatic = false;
  const char *reason = "";
  uint32_t durationMs = 0;
  uint32_t since = 0;
  uint8_t safeSamples = 0;
  WATER_CONSTEXPR bool active() const {
    return stage == Stage::Draining || stage == Stage::Switching || stage == Stage::Filling || stage == Stage::Settling;
  }
  WATER_CONSTEXPR bool drain() const { return stage == Stage::Draining; }
  WATER_CONSTEXPR bool fill() const { return stage == Stage::Filling; }
  WATER_CONSTEXPR bool requiresLevelCheck() const { return stage == Stage::Locked || (stage == Stage::Error && automatic); }
  bool manualBlocked() const { return requiresLevelCheck() || (stage == Stage::Error && strcmp(reason, "storage-error") == 0); }
  WATER_CONSTEXPR const char *stageName() const {
    switch (stage) {
      case Stage::Draining: return "draining";
      case Stage::Switching: return "switching";
      case Stage::Filling: return "filling";
      case Stage::Settling: return "settling";
      case Stage::Locked: return "locked";
      case Stage::Error: return "error";
      default: return "idle";
    }
  }
  WATER_CONSTEXPR uint32_t remaining(uint32_t now) const {
    uint32_t target = stage == Stage::Settling ? SETTLE_MS : stage == Stage::Switching ? SWITCH_MS : durationMs;
    return active() && now - since < target ? target - (now - since) : 0;
  }
  bool start(uint8_t requestedPercent, bool isAuto, uint32_t now, bool overflow = false) {
    if (active() || manualBlocked() || (stage == Stage::Error && isAuto) || overflow || !isfinite(config.tankLiters) || config.tankLiters < 1 || config.tankLiters > 500) return false;
    if (requestedPercent < 1 || requestedPercent > 50) return false;
    if (isAuto && (!config.autoEnabled || attempts >= 3 || requestedPercent != 20)) return false;
    durationMs = static_cast<uint32_t>(config.tankLiters * requestedPercent / 100.0 / FLOW_LPH * 3600000.0 + 0.5);
    percent = requestedPercent;
    automatic = isAuto;
    if (isAuto) ++attempts;
    safeSamples = 0;
    stage = Stage::Draining; since = now; reason = "";
    return true;
  }
  WATER_CONSTEXPR void abort(const char *why) {
    if (!active()) return;
    stage = Stage::Error; reason = why; safeSamples = 0;
  }
  // Used after a power loss mid-cycle. Never resume a partially completed fill.
  WATER_CONSTEXPR void restore(uint8_t savedAttempts, bool interrupted, bool wasAutomatic = true) {
    attempts = savedAttempts > 3 ? 3 : savedAttempts;
    automatic = wasAutomatic;
    if (interrupted) { stage = Stage::Error; reason = wasAutomatic ? "interrupted-check-level" : "interrupted-manual"; }
    else if (attempts >= 3) stage = Stage::Locked;
  }
  WATER_CONSTEXPR uint8_t guardValue() const {
    return 32 | attempts | ((automatic || stage == Stage::Locked) ? 64 : 0) | ((active() || stage == Stage::Error) ? 128 : 0);
  }
  WATER_CONSTEXPR void restoreGuard(uint8_t saved) {
    const bool wasAutomatic = (saved & 32) ? (saved & 64) != 0 : (saved & 128) != 0 || (saved & 3) >= 3;
    restore(saved & 3, (saved & 128) != 0, wasAutomatic);
  }
  WATER_CONSTEXPR bool resetAfterLevelCheck(bool confirmed = false) {
    if (active() || (requiresLevelCheck() && !confirmed)) return false;
    attempts = 0; safeSamples = 0; stage = Stage::Idle; reason = "";
    automatic = false;
    return true;
  }
  WATER_CONSTEXPR void tick(uint32_t now, bool overflow) {
    if (!active()) return;
    if (overflow) { abort("overflow"); return; }
    const uint32_t elapsed = now - since;
    if ((drain() || fill()) && elapsed > durationMs + 2000) { abort("phase-timeout-check-level"); return; }
    if (drain() && elapsed >= durationMs) { stage = Stage::Switching; since = now; }
    else if (stage == Stage::Switching && elapsed >= SWITCH_MS) { stage = Stage::Filling; since = now; }
    else if (fill() && elapsed >= durationMs) { stage = Stage::Settling; since = now; }
    else if (stage == Stage::Settling && !automatic && elapsed >= SETTLE_MS) { stage = Stage::Idle; reason = ""; }
    // Automatic settling still requires fresh valid sensor readings before another attempt.
  }
  void sample(uint32_t now, const float values[4], bool manualBusy, bool overflow) {
    if (stage == Stage::Error) return;
    if (active() && stage != Stage::Settling) return;
    if (stage == Stage::Settling && now - since < SETTLE_MS) return;
    bool abnormal = false;
    for (uint8_t i = 0; i < 4; ++i) {
      if (!config.ranges[i].enabled) continue;
      if (!isfinite(values[i])) { safeSamples = 0; return; }
      abnormal |= values[i] < config.ranges[i].min || values[i] > config.ranges[i].max;
    }
    if (stage == Stage::Settling) stage = attempts >= 3 ? Stage::Locked : Stage::Idle;
    if (!abnormal) {
      // Three consecutive fresh safe readings re-arm a recovered incident.
      if (++safeSamples >= 3) { attempts = 0; safeSamples = 0; stage = Stage::Idle; reason = ""; }
      return;
    }
    safeSamples = 0;
    if (attempts >= 3) { stage = Stage::Locked; reason = "max-attempts"; return; }
    if (!manualBusy && !overflow) start(20, true, now);
  }
};
}
#undef WATER_CONSTEXPR
