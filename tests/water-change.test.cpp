#include <cassert>
#include <iostream>
#include "../firmware/aquarium-node/water-change.h"
#include "../firmware/aquarium-node/sensor-estimates.h"
using namespace WaterChange;

int main() {
  Controller c;
  assert(!c.start(20, false, 0)); // No tank volume.
  c.config.tankLiters = 60;
  assert(!c.start(20, true, 0)); // Auto starts disabled.
  assert(!c.start(0, false, 0) && !c.start(51, false, 0));
  assert(c.start(25, false, 100));
  assert(c.durationMs == 562500); // 15 L / 96 L/h = 562.5 seconds per phase.
  assert(c.drain() && !c.fill());
  assert(!c.start(10, false, 101));
  c.tick(562600, false);
  assert(c.stage == Stage::Switching && !c.drain() && !c.fill());
  c.tick(563600, false);
  assert(c.fill() && !c.drain());
  c.tick(1126100, false);
  assert(c.stage == Stage::Settling);
  const float good[] = {26, 7.2f, 220, 10};
  c.sample(1126101, good, false, false);
  assert(c.stage == Stage::Settling);
  c.sample(1186100, good, false, false);
  assert(c.stage == Stage::Idle);
  c.config.autoEnabled = true;
  const float bad[] = {26, 9.5f, 220, 10};
  uint32_t now = 1200000;
  for (int i = 1; i <= 3; ++i) {
    c.sample(now, bad, false, false);
    assert(c.drain() && c.automatic && c.attempts == i);
    now += c.durationMs; c.tick(now, false);
    now += SWITCH_MS; c.tick(now, false);
    now += c.durationMs; c.tick(now, false);
    now += SETTLE_MS;
  }
  c.sample(now, bad, false, false);
  assert(c.stage == Stage::Locked && c.attempts == 3);
  c.sample(now + 1, good, false, false);
  c.sample(now + 2, good, false, false);
  c.sample(now + 3, good, false, false);
  assert(c.attempts == 0 && c.stage == Stage::Idle);
  assert(c.start(10, false, now + 4));
  c.abort("cancelled-check-level");
  assert(c.stage == Stage::Error && !c.requiresLevelCheck());
  assert(c.start(20, false, now + 5)); // A manually stopped cycle can be started again without level confirmation.
  c.abort("cancelled-check-level");
  c.resetAfterLevelCheck();
  c.restore(2, true);
  assert(c.stage == Stage::Error && c.attempts == 2);
  assert(c.requiresLevelCheck() && !c.resetAfterLevelCheck());
  assert(c.resetAfterLevelCheck(true));
  assert(c.start(10, false, 0));
  c.tick(1, true);
  assert(c.stage == Stage::Error); // Overflow fails closed.
  c.resetAfterLevelCheck();
  c.start(10, false, 0);
  c.tick(c.durationMs + 2001, false);
  assert(c.stage == Stage::Error); // Late phase cannot fill for an unknown drain volume.
  c.resetAfterLevelCheck();
  const float invalid[] = {26, NAN, 220, 10};
  c.sample(now, invalid, false, false);
  assert(c.stage == Stage::Idle);
  assert(fabs(SensorEstimates::ph(1.831f, SensorEstimates::PH_REFERENCE_ADC) - 7) < .001);
  // Real two-point calibration derives its slope from measured buffer voltages.
  assert(SensorEstimates::calibrationReady(2.0f, 2.3f));
  assert(!SensorEstimates::calibrationReady(2.0f, 2.005f));
  assert(fabs(SensorEstimates::calibratedPH(2.0f, 2.0f, 2.3f) - 7) < .001);
  assert(fabs(SensorEstimates::calibratedPH(2.3f, 2.0f, 2.3f) - 4) < .001);
  assert(fabs(SensorEstimates::calibratedPH(2.15f, 2.0f, 2.3f) - 5.5f) < .001);
  assert(fabs(SensorEstimates::calibratedPH(1.85f, 2.0f, 1.7f) - 5.5f) < .001);
  assert(isnan(SensorEstimates::calibratedPH(2.0f, 2.0f, 2.0f)));
  assert(SensorEstimates::turbidityPercent(3.272f) == 0);
  assert(fabs(SensorEstimates::turbidityPercent(1.636f) - 50) < .001);
  assert(isnan(SensorEstimates::ph(3.3f, SensorEstimates::PH_REFERENCE_ADC)));
  // Reboot must stop both types, while preserving who initiated the cycle.
  c.config.autoEnabled = true;
  c.start(25, false, 0);
  const uint8_t manualGuard = c.guardValue();
  Controller manualBoot; manualBoot.config.tankLiters = 60; manualBoot.restoreGuard(manualGuard);
  assert(manualBoot.stage == Stage::Error && !manualBoot.active() && !manualBoot.requiresLevelCheck());
  assert(manualBoot.start(25, false, 100));
  assert(c.resetAfterLevelCheck() == false); // Cannot reset an active cycle.
  c.abort("stop"); c.resetAfterLevelCheck(); c.start(20, true, 0);
  Controller autoBoot; autoBoot.config.tankLiters = 60; autoBoot.restoreGuard(c.guardValue());
  assert(autoBoot.requiresLevelCheck() && !autoBoot.start(25, false, 100));
  assert(!autoBoot.resetAfterLevelCheck() && autoBoot.resetAfterLevelCheck(true));
  Controller legacy; legacy.restoreGuard(128);
  assert(legacy.requiresLevelCheck()); // Older NVS guards did not record origin.

  SensorEstimates::PhVoltageFilter filter;
  const float samples[] = {1.819f,1.834f,1.831f,1.829f,1.843f,1.829f,1.818f,1.829f,1.833f,1.831f,1.833f,1.835f,1.831f,1.831f,1.844f};
  float filteredMin = 14, filteredMax = 0;
  for (uint8_t i = 0; i < 15; ++i) {
    const float ph = SensorEstimates::ph(filter.update(samples[i]), SensorEstimates::PH_REFERENCE_ADC);
    assert(ph > 6.8f && ph < 7.2f);
    if (i >= 5) { filteredMin = fminf(filteredMin, ph); filteredMax = fmaxf(filteredMax, ph); }
  }
  assert(filteredMax - filteredMin < .10f);
  // A single valid but large spike is rejected; three sustained new readings are followed.
  assert(SensorEstimates::ph(filter.update(1.5f), SensorEstimates::PH_REFERENCE_ADC) < 7.2f);
  filter.update(1.831f);
  for (uint8_t i = 0; i < 3; ++i) filter.update(1.731f);
  assert(fabs(SensorEstimates::ph(filter.update(1.731f), SensorEstimates::PH_REFERENCE_ADC) - 8) < .05f);
  assert(isnan(filter.update(3.134f)));
  assert(fabs(filter.update(1.831f) - 1.831f) < .001f);
  std::cout << "User sample replay after warmup: pH " << filteredMin << " to " << filteredMax << "\n";
  std::cout << "PASS: firmware water phases, flow, auto limits, abort/reboot/overflow, calibration\n";
}
