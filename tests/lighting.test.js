import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import aedesFactory from 'aedes';
import mqtt from 'mqtt';

test('lighting: schedule, manual handover, thermostat and persisted configuration protocol', { timeout: 15000 }, async t => {
  const broker = aedesFactory();
  const server = net.createServer(broker.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `mqtt://127.0.0.1:${server.address().port}`;
  const client = mqtt.connect(url);
  let child, state;
  const root = 'aquarium/esp32-light-test';
  t.after(async () => {
    if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await client.endAsync(true);
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  await once(client, 'connect');
  await client.subscribeAsync(`${root}/state`);
  client.on('message', (_, bytes) => { state = JSON.parse(bytes); });
  child = spawn(process.execPath, ['tools/simulate-device.js', '--device', 'esp32-light-test', '--key', 'fixture-key', '--url', url, '--clock-minute', '600', '--time-scale', '0.01', '--interval', '0.05'], { windowsHide: true, stdio: 'ignore' });
  const waitFor = async check => {
    const until = Date.now() + 4000;
    while (Date.now() < until) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Timed out waiting for light state: ' + JSON.stringify(state));
  };
  await waitFor(() => state);
  const config = { revision: 1, tankLiters: 10, autoEnabled: false,
    thresholds: { temperature: { min: 24, max: 28 }, ph: { min: 6, max: 9 }, tds: { min: 0, max: 1000 }, turbidity_percent: { min: 0, max: 100 } },
    lighting: { scheduleEnabled: true, onMinute: 480, offMinute: 960, utcOffsetMinutes: 420, heatEnabled: false, heatOn: 24, heatOff: 25 } };
  const save = () => client.publishAsync(`${root}/config`, JSON.stringify(config), { retain: true });
  await save();
  await waitFor(() => state.settings_revision === 1 && state.pumps.light);
  assert.equal(state.relay_timers.light.source, 'schedule');
  await client.publishAsync(`${root}/cmd`, JSON.stringify({ id: 'manual', pump: 'light', action: 'on', duration: 60 }));
  await waitFor(() => state.lighting.manual_override);
  await waitFor(() => !state.lighting.manual_override && state.pumps.light);
  assert.equal(state.relay_timers.light.source, 'schedule');
  config.revision++;
  config.lighting = { ...config.lighting, onMinute: 1320, offMinute: 360 };
  await save();
  await waitFor(() => state.settings_revision === 2 && !state.pumps.light);
  config.revision++;
  config.lighting = { ...config.lighting, scheduleEnabled: false, heatEnabled: true, heatOn: 26, heatOff: 27 };
  await save();
  await waitFor(() => state.settings_revision === 3 && state.pumps.light);
  assert.equal(state.relay_timers.light.source, 'temperature');
  await client.publishAsync(`${root}/cmd`, JSON.stringify({ id: 'stop-light', pump: 'light', action: 'off' }));
  await waitFor(() => !state.pumps.light && state.lighting.manual_override);
});
