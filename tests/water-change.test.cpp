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
  assert(c.stage == Stage::Error && !c.start(20, false, now + 5));
  c.resetAfterLevelCheck();
  c.restore(2, true);
  assert(c.stage == Stage::Error && c.attempts == 2);
  c.resetAfterLevelCheck();
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
  assert(fabs(SensorEstimates::ph(1.927f, SensorEstimates::PH_REFERENCE_ADC) - 7) < .001);
  assert(SensorEstimates::turbidityPercent(3.272f) == 0);
  assert(fabs(SensorEstimates::turbidityPercent(1.636f) - 50) < .001);
  assert(isnan(SensorEstimates::ph(3.3f, 1.927f)));
  std::cout << "PASS: firmware water phases, flow, auto limits, abort/reboot/overflow, calibration\n";
}
