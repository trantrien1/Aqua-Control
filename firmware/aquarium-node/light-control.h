#pragma once
#include <stdint.h>
#include <math.h>

// Daily intervals use local minutes; clock synchronization is handled by the sketch.
namespace LightControl {
struct Config {
  bool scheduleEnabled = false;
  uint16_t onMinute = 480;
  uint16_t offMinute = 960;
  int16_t utcOffsetMinutes = 420;
  bool heatEnabled = false;
  float heatOn = 24;
  float heatOff = 25;
};
class Controller {
  bool heating = false;
  bool overridden = false;
  uint32_t overrideSince = 0;
  uint32_t overrideDuration = 0;
public:
  bool scheduled = false;
  bool heatDemand = false;
  bool automaticOn = false;
  bool manualActive(uint32_t now) {
    if (overridden && now - overrideSince >= overrideDuration) overridden = false;
    return overridden;
  }
  void manual(uint32_t now, uint32_t durationMs) {
    overridden = true; overrideSince = now; overrideDuration = durationMs;
    automaticOn = false;
  }
  bool update(const Config &cfg, bool clockValid, uint16_t minute, float temperature,
              bool temperatureFresh, uint32_t now) {
    scheduled = cfg.scheduleEnabled && clockValid && cfg.onMinute != cfg.offMinute &&
      (cfg.onMinute < cfg.offMinute ? minute >= cfg.onMinute && minute < cfg.offMinute
                                   : minute >= cfg.onMinute || minute < cfg.offMinute);
    if (!cfg.heatEnabled || !temperatureFresh || !isfinite(temperature)) heating = false;
    else if (temperature < cfg.heatOn) heating = true;
    else if (temperature >= cfg.heatOff) heating = false;
    heatDemand = heating;
    automaticOn = !manualActive(now) && (scheduled || heatDemand);
    return automaticOn;
  }
  const char *source() const { return scheduled && heatDemand ? "schedule+temperature" : heatDemand ? "temperature" : "schedule"; }
};
}
