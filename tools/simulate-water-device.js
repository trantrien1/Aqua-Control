#!/usr/bin/env node
/** ESP32 v3 simulator: timed relays, configuration ACK and local water recovery. */
import mqtt from 'mqtt';
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const deviceId = arg('device', process.env.DEVICE_ID);
const key = arg('key', process.env.DEVICE_KEY);
const scenario = arg('scenario', 'relay-test');
const interval = Math.max(0.05, Number(arg('interval', 5))) * 1000;
const scale = Math.max(0.001, Number(arg('time-scale', 1)));
const once = argv.includes('--once');
if (!deviceId || !key) { console.error('Cần DEVICE_ID và DEVICE_KEY do web cấp.'); process.exit(1); }
const topic = suffix => `${process.env.MQTT_TOPIC_PREFIX || 'aquarium'}/${deviceId}/${suffix}`;
const pumps = { drain: false, fill: false, light: false };
const ends = {};
let settings = { revision: 0, tankLiters: null, autoEnabled: false, thresholds: {
  temperature: { min: 24, max: 28 }, ph: { min: 6.8, max: 8.2 }, tds: { min: 180, max: 280 }, turbidity_percent: { min: 0, max: 30 },
} };
const bases = {
  normal: [25.6, 7.35, 225, 8], 'relay-test': [25.6, 7.35, 225, 8], 'water-test': [25.6, 7.35, 225, 8],
  critical: [33, 9.25, 470, 65], low: [21.4, 6.15, 95, 20], drift: [29, 8.4, 340, 35],
};
let values = [...(bases[scenario] || bases.normal)];
const caps = { pumps: scenario !== 'water-test', relay_keys: scenario === 'water-test' ? [] : Object.keys(pumps), water_change: scenario !== 'water-test', water_recovery: scenario !== 'water-test', water_level: false, turbidity_voltage: true, turbidity_percent: true };
let water = { stage: 'idle', percent: 0, attempts: 0, automatic: false, reason: '', remaining_ms: 0 };
let deadline = 0, phase = 0, safeSamples = 0;
let lastConnectedAt = Date.now();
const active = () => ['draining', 'switching', 'filling', 'settling'].includes(water.stage);
const seen = new Set();
const client = mqtt.connect(arg('url', process.env.MQTT_URL || 'mqtt://127.0.0.1:1883'), {
  clientId: `sim-${deviceId}`, username: deviceId, password: key, reconnectPeriod: 2000,
  will: { topic: topic('status'), payload: Buffer.from('offline'), qos: 1, retain: true },
});
function setPump(pump, on, seconds = 0) {
  if (!Object.hasOwn(pumps, pump)) return false;
  if (on && pump !== 'light') { const other = pump === 'drain' ? 'fill' : 'drain'; pumps[other] = false; delete ends[other]; }
  pumps[pump] = on;
  if (on) ends[pump] = Date.now() + seconds * 1000 * scale;
  else delete ends[pump];
  return true;
}
function report() {
  return { firmware: 'simulator-3.0-water', capabilities: caps, pumps,
    settings_revision: settings.revision,
    water_change: { ...water, remaining_ms: active() ? Math.max(0, (deadline - Date.now()) / scale) : 0 },
    relay_timers: Object.fromEntries(Object.keys(pumps).map(k => [k, { remaining_ms: pumps[k] ? Math.max(0, ((ends[k] || deadline) - Date.now()) / scale) : 0, source: k !== 'light' && active() ? water.automatic ? 'auto' : 'water_change' : 'mqtt' }])),
  };
}
function publishState() { if (client.connected) client.publish(topic('state'), JSON.stringify(report()), { qos: 1, retain: true }); }
function stage(next, duration) { water.stage = next; deadline = Date.now() + duration * scale; publishState(); }
function start(percent, automatic) {
  if (active() || water.stage === 'error' || !settings.tankLiters || percent < 1 || percent > 50 || !Number.isInteger(percent) || (automatic && (!settings.autoEnabled || water.attempts >= 3))) return false;
  water.percent = percent; water.automatic = automatic; water.reason = ''; safeSamples = 0;
  if (automatic) water.attempts++;
  phase = Math.round(settings.tankLiters * percent / 100 / 96 * 3600000);
  setPump('drain', true, phase / 1000); stage('draining', phase);
  return true;
}
function stop() {
  if (active()) { water.stage = 'error'; water.reason = 'cancelled-check-level'; }
  setPump('drain', false); setPump('fill', false); publishState();
}
function sample() {
  if (water.stage === 'error' || (active() && (water.stage !== 'settling' || Date.now() < deadline))) return;
  const keys = ['temperature', 'ph', 'tds', 'turbidity_percent'];
  if (values.some(v => !Number.isFinite(v))) { safeSamples = 0; return; }
  const abnormal = keys.some((k, i) => values[i] < settings.thresholds[k].min || values[i] > settings.thresholds[k].max);
  if (water.stage === 'settling') stage(water.attempts >= 3 ? 'locked' : 'idle', 0);
  if (!abnormal) {
    if (++safeSamples >= 3) { water.attempts = 0; safeSamples = 0; water.reason = ''; stage('idle', 0); }
  } else {
    safeSamples = 0;
    if (water.attempts >= 3) { water.reason = 'max-attempts'; stage('locked', 0); }
    else if (!pumps.drain && !pumps.fill && caps.water_change) start(20, true);
  }
}
function telemetry() {
  if (!client.connected || ['draining', 'filling'].includes(water.stage)) return;
  sample();
  client.publish(topic('telemetry'), JSON.stringify({ ...report(), ts: Date.now(), temperature: values[0], ph: scenario === 'water-test' ? null : values[1], tds: values[2], turbidity: null,
    turbidity_percent: values[3], turbidity_voltage: 3.272 * (1 - values[3] / 100), water_level: null,
    rssi: -58, sensor_status: { ph_calibrated: false, ph_estimated: true, ph_fixed_reference: true, ph_reference_adc_voltage: 1.927, turbidity_reference_voltage: 3.272, tds_estimated: true, tds_temperature_fallback: false } }), { qos: 1 });
  console.log(`[sim] ${deviceId}: ${values[0]}°C · pH ${values[1]} · TDS ${values[2]} · đục ${values[3]}% · ${water.stage}`);
}
client.on('connect', () => {
  console.log(`[sim] MQTT connected · ${deviceId} · ${scenario}`);
  client.subscribe([topic('cmd'), topic('config')], { qos: 1 });
  client.publish(topic('status'), 'online', { qos: 1, retain: true }); publishState(); telemetry();
  if (once) setTimeout(() => client.end(false, () => process.exit(0)), 600);
});
client.on('message', (t, bytes) => {
  let cmd;
  try { cmd = JSON.parse(bytes); } catch { return; }
  if (t === topic('config')) {
    if (Number.isInteger(cmd.revision) && cmd.revision >= settings.revision && !active() && !pumps.drain && !pumps.fill && cmd.thresholds) settings = cmd;
    publishState(); return;
  }
  if (t !== topic('cmd')) return;
  let ok = false;
  if (cmd.id && seen.has(cmd.id)) ok = true;
  else if (cmd.type === 'water_change') {
    if (cmd.action === 'stop') { stop(); ok = true; }
    if (cmd.action === 'reset' && !active() && !pumps.drain && !pumps.fill) { water = { stage: 'idle', percent: 0, attempts: 0, automatic: false, reason: '' }; ok = true; }
    if (cmd.action === 'start' && cmd.settings_revision === settings.revision && !pumps.drain && !pumps.fill) ok = start(cmd.percent, false);
  } else if (caps.pumps && ['on', 'off'].includes(cmd.action)) {
    if (cmd.action === 'off') { if (cmd.pump !== 'light') stop(); ok = setPump(cmd.pump, false); }
    else if (cmd.pump === 'light' || (!active() && water.stage !== 'error')) ok = setPump(cmd.pump, true, Math.max(1, Math.min(3600, Math.floor(Number(cmd.duration) || 3))));
  }
  if (ok && cmd.id) { seen.add(cmd.id); if (seen.size > 32) seen.delete(seen.values().next().value); }
  publishState();
  client.publish(topic('ack'), JSON.stringify({ ...report(), id: cmd.id, type: cmd.type, pump: cmd.pump, action: cmd.action, ok, reason: ok ? '' : 'water-change-busy-or-invalid' }), { qos: 1 });
});
setInterval(telemetry, interval).unref();
setInterval(() => {
  const now = Date.now();
  if (client.connected) lastConnectedAt = now;
  let changed = false;
  if (active() && now >= deadline) {
    if (water.stage === 'draining') { setPump('drain', false); stage('switching', 1000); }
    else if (water.stage === 'switching') { setPump('fill', true, phase / 1000); stage('filling', phase); }
    else if (water.stage === 'filling') {
      setPump('fill', false);
      values = values.map((v, i) => v * (1 - water.percent / 100) + bases.normal[i] * water.percent / 100);
      stage('settling', 60000);
    }
  }
  for (const k of Object.keys(ends)) if (now >= ends[k] && !(k !== 'light' && active())) { setPump(k, false); changed = true; }
  if (!client.connected && now - lastConnectedAt > 60000 * scale) {
    for (const k of Object.keys(pumps)) if (pumps[k] && !(k !== 'light' && active())) { setPump(k, false); changed = true; }
  }
  if (changed) publishState();
}, Math.max(5, 100 * scale)).unref();
setInterval(publishState, 5000).unref();
client.on('error', err => console.error('[sim]', err.message));
process.on('SIGINT', () => { client.publish(topic('status'), 'offline', { qos: 1, retain: true }); client.end(false, () => process.exit(0)); });
