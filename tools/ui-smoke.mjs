/**
 * Kiểm thử giao diện bằng Chrome headless qua giao thức DevTools (CDP).
 * Không cần cài Playwright: Node 24 đã có sẵn WebSocket và fetch.
 *
 *   node tools/ui-smoke.mjs [--base http://127.0.0.1:3000] [--password beca123]
 *                           [--chrome "C:\\...\\chrome.exe"] [--out .ui-smoke]
 *                           [--verify-aqua]
 *
 * Kết quả: DOM, lỗi console/CSP, bố cục 5 kích thước, ảnh desktop/mobile/login.
 * --verify-aqua dùng fixture trình duyệt và chặn POST điều khiển, cần simulator
 * có relay để kiểm tra trạng thái chờ ACK, null, offline và dữ liệu cũ.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argOf("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const PASSWORD = argOf("password", "beca123");
const OUT_DIR = path.resolve(argOf("out", ".ui-smoke"));
const PORT = Number(argOf("port", "9333"));
const VERIFY_AQUA = args.includes("--verify-aqua");
const CHROME =
  argOf("chrome", null) ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error(
    "Không tìm thấy Chrome hoặc Edge. Truyền đường dẫn bằng --chrome.",
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });
const userDataDir = path.join(OUT_DIR, "profile");

const browser = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,1200",
    "about:blank",
  ],
  { stdio: "ignore", detached: false, windowsHide: true },
);

let ws = null;
let nextId = 1;
const pending = new Map();
const consoleLog = [];
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 20000);
  });
}

async function waitForTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome chưa lên */
    }
    await sleep(250);
  }
  throw new Error("Không kết nối được Chrome DevTools sau 15 giây.");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) =>
      reject(new Error(`WebSocket lỗi: ${e.message || "unknown"}`)),
    );
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error)
          fail(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        consoleLog.push({ type: msg.params.type, text });
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        pageErrors.push(d.exception?.description || d.text);
      } else if (msg.method === "Log.entryAdded") {
        const e = msg.params.entry;
        if (e.level === "error") pageErrors.push(`${e.source}: ${e.text}`);
        else consoleLog.push({ type: e.level, text: e.text });
      }
    });
  });
}

async function evaluate(expression, { awaitPromise = false } = {}) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

async function waitForLoad() {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Page.loadEventFired") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve();
      }
    };
    ws.addEventListener("message", handler);
  });
}

const PROBE = `(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim().slice(0, 160) ?? null;
  const metricEls = [...document.querySelectorAll('.metric')];
  return {
    url: location.pathname,
    title: document.title,
    connection: text('#conn-text'),
    metricCount: metricEls.length,
    metrics: metricEls.map((el) => ({
      label: el.querySelector('.metric__label')?.textContent?.trim(),
      num: el.querySelector('.metric__num')?.textContent?.trim(),
      unit: el.querySelector('.metric__unit')?.textContent?.trim() ?? '',
      status: el.dataset.status,
      badge: el.querySelector('.badge')?.textContent?.trim(),
    })),
    alertCount: document.querySelectorAll('.alert-row').length,
    alertEmpty: text('.empty__title'),
    pumpCount: document.querySelectorAll('.pump').length,
    pumps: [...document.querySelectorAll('.pump')].map((el) => ({
      title: el.querySelector('.pump__title')?.textContent?.trim(),
      state: el.querySelector('.pump__state')?.textContent?.trim(),
      timer: el.querySelector('.pump__timer')?.textContent?.trim(),
      onDisabled: el.querySelector('[data-action="on"]')?.disabled,
    })),
    chartSummary: text('#chart-summary'),
    chartPixels: (() => {
      const c = document.getElementById('chart');
      return c ? c.width + 'x' + c.height : null;
    })(),
    alertRows: document.querySelectorAll('#alert-log tbody tr').length,
    pumpRows: document.querySelectorAll('#pump-log tbody tr').length,
    tabs: document.querySelectorAll('#metric-tabs .tab').length,
    rangeTabs: document.querySelectorAll('#range-tabs .tab').length,
  };
})()`;

// Optional browser-only fixtures. POST commands are intercepted, so this mode
// never operates physical relays. Real HTML, modules, history and login are used.
const AQUA_HARNESS = `(() => {
  const nativeFetch = window.fetch.bind(window);
  const harness = window.__aquaHarness = { snapshot: null, streams: [] };
  harness.emit = (snapshot) => {
    harness.snapshot = snapshot;
    for (const stream of harness.streams) stream.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) }));
  };
  window.EventSource = class extends EventTarget {
    constructor() { super(); harness.streams.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    close() {}
  };
  window.fetch = async (input, options = {}) => {
    const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (pathname === '/api/state') {
      if (!harness.snapshot) {
        const response = await nativeFetch(input, options);
        if (!response.ok) return response;
        harness.snapshot = await response.clone().json();
        return response;
      }
      return new Response(JSON.stringify(harness.snapshot), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (options.method === 'POST' && pathname.startsWith('/api/pumps/')) {
      const key = decodeURIComponent(pathname.split('/').at(-1));
      const command = JSON.parse(options.body);
      const next = structuredClone(harness.snapshot);
      const pump = next.pumps.find(p => p.key === key);
      pump.pending = true;
      pump.pendingAction = command.action;
      next.device.ageMs = 0;
      next.readingAgeMs = 0;
      harness.emit(next);
      await new Promise(resolve => setTimeout(resolve, 200));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return nativeFetch(input, options);
  };
})()`;

async function verifyAqua() {
  const results = [];
  const base = await evaluate(`structuredClone(window.__aquaHarness.snapshot)`);
  assert.ok(base && base.params.length, "Preview requires at least one sensor");
  assert.ok(
    base.pumps.some((p) => p.available),
    "Preview requires relay-capable simulator",
  );
  const emit = async (snapshot) => {
    snapshot.now = Date.now();
    await evaluate(`window.__aquaHarness.emit(${JSON.stringify(snapshot)})`);
    await sleep(70);
  };
  const fresh = () => {
    const snapshot = structuredClone(base);
    snapshot.device.online = true;
    snapshot.device.ageMs = 0;
    snapshot.readingAgeMs = 0;
    return snapshot;
  };
  await emit(fresh());
  const key = base.pumps.find((p) => p.available).key;
  await evaluate(
    `document.querySelector('[data-pump="${key}"] [data-action="on"]').click()`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#pump-dialog').open`),
    true,
    "Timed control dialog opens",
  );
  await evaluate(`document.querySelector('#dialog-confirm').click()`);
  await sleep(400);
  const pendingState = await evaluate(
    `(() => { const card = document.querySelector('[data-pump="${key}"]'); return { on: card.classList.contains('is-on'), feedback: card.querySelector('.command-feedback')?.textContent }; })()`,
  );
  assert.equal(
    pendingState.on,
    !!base.pumps.find((p) => p.key === key).on,
    "HTTP acceptance must not change actual relay state",
  );
  assert.match(pendingState.feedback, /Chờ ESP32 xác nhận bật/);
  results.push("accepted command remains pending until device confirmation");

  const confirmed = fresh();
  Object.assign(
    confirmed.pumps.find((p) => p.key === key),
    {
      on: true,
      confirmed: true,
      pending: false,
      since: Date.now(),
      offAt: Date.now() + 3000,
    },
  );
  await emit(confirmed);
  assert.equal(
    await evaluate(
      `document.querySelector('[data-pump="${key}"]').classList.contains('is-on')`,
    ),
    true,
  );
  results.push("confirmed relay state and countdown render");

  const nullValue = fresh();
  Object.assign(
    nullValue.params.find((p) => p.key === "ph"),
    { value: null, status: "nodata", statusText: "Chưa hiệu chuẩn" },
  );
  nullValue.reading.ph = null;
  await emit(nullValue);
  assert.equal(
    await evaluate(
      `document.querySelector('[data-metric-key="ph"] .metric__num').textContent`,
    ),
    "—",
  );
  results.push("null pH remains missing, never zero");

  const stale = fresh();
  stale.readingAgeMs = stale.device.staleAfterMs + 1000;
  await emit(stale);
  assert.equal(
    await evaluate(`document.querySelector('#sensor-freshness').textContent`),
    "Dữ liệu cũ",
  );
  assert.equal(
    await evaluate(`document.querySelector('#good-count').textContent`),
    "—",
  );
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('.metric .badge')].every(b => b.textContent.includes('Dữ liệu cũ'))`,
    ),
    true,
  );
  results.push("fresh device heartbeat does not hide stale telemetry");

  const unavailable = fresh();
  unavailable.pumps.find((p) => p.key === key).available = false;
  await emit(unavailable);
  assert.equal(
    await evaluate(
      `document.querySelector('[data-pump="${key}"] [data-action="on"]').disabled`,
    ),
    true,
  );
  results.push("unavailable firmware capability disables control");

  const offline = confirmed;
  offline.device.online = false;
  await emit(offline);
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[data-action]')].every(button => button.disabled)`,
    ),
    true,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('.pump.is-on').length`),
    0,
  );
  results.push("offline relays display no asserted on-state and block control");

  await emit(fresh());
  await evaluate(
    `window.__aquaHarness.streams.forEach(stream => stream.dispatchEvent(new Event('error')))`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#conn-text').textContent`),
    "Mất kết nối máy chủ",
  );
  assert.equal(
    await evaluate(`document.querySelector('#stop-all').disabled`),
    true,
  );
  await emit(fresh());
  assert.equal(
    await evaluate(`document.querySelector('#stop-all').disabled`),
    false,
  );
  results.push("SSE disconnect and recovery update connection and controls");
  const focusedSelector = `[data-pump="${key}"] [data-action="on"]`;
  await evaluate(
    `document.querySelector(${JSON.stringify(focusedSelector)}).focus()`,
  );
  await emit(fresh());
  assert.equal(
    await evaluate(
      `document.activeElement.matches(${JSON.stringify(focusedSelector)})`,
    ),
    true,
  );
  results.push("telemetry preserves keyboard focus on device controls");
  return results;
}

async function main() {
  const wsUrl = await waitForTarget();
  await connect(wsUrl);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  if (VERIFY_AQUA)
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: AQUA_HARNESS,
    });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 1. Trang đăng nhập
  await send("Page.navigate", { url: `${BASE}/login` });
  await waitForLoad();
  await sleep(400);
  const loginProbe = await evaluate(`(() => ({
    url: location.pathname,
    hasForm: !!document.getElementById('login-form'),
    autofocusOk: document.activeElement?.id ?? null,
  }))()`);
  const loginShot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(OUT_DIR, "login.png"),
    Buffer.from(loginShot.data, "base64"),
  );

  // 2. Đăng nhập bằng fetch trong chính trang (cookie same-origin)
  const loginResult = await evaluate(
    `fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(
      PASSWORD,
    )} }) }).then(r => r.status)`,
    { awaitPromise: true },
  );

  // 3. Bảng điều khiển
  await send("Page.navigate", { url: `${BASE}/` });
  await waitForLoad();
  await sleep(2500);
  const probe = await evaluate(PROBE);

  // 4. Bấm thử một tab tham số rồi chụp ảnh
  await evaluate(`(() => {
    const btn = document.querySelector('#metric-tabs .tab[data-metric="ph"]');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(1200);
  const chartAfterTab = await evaluate(
    `document.querySelector('#chart-summary')?.textContent?.trim() ?? null`,
  );

  const fullHeight = await evaluate(
    `Math.min(2400, document.documentElement.scrollHeight)`,
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: fullHeight || 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  const shotPath = path.join(OUT_DIR, "dashboard.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));

  const layouts = [];
  for (const width of [320, 390, 768, 1024, 1440]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(150);
    const layout = await evaluate(
      `(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, sections: ['.alerts-section','.sensors-section','.control-section','.chart-card','.habitat-grid'].map(selector => document.querySelector(selector).getBoundingClientRect().top), imageLoaded: document.querySelector('.habitat-card img').naturalWidth > 0, fontLoaded: document.fonts.check('600 16px "Be Vietnam Pro"') }))()`,
    );
    assert.ok(
      layout.scrollWidth <= width,
      "No document overflow at width " + width,
    );
    assert.equal(layout.imageLoaded, true, "Aquarium image loads locally");
    assert.equal(layout.fontLoaded, true, "Vietnamese font loads locally");
    if (width <= 760)
      assert.deepEqual(
        layout.sections,
        [...layout.sections].sort((a, b) => a - b),
        "Mobile prioritizes alerts, sensors, controls and chart",
      );
    layouts.push(layout);
    if (width === 390) {
      await evaluate("window.scrollTo(0, 0)");
      const mobileShot = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      fs.writeFileSync(
        path.join(OUT_DIR, "mobile.png"),
        Buffer.from(mobileShot.data, "base64"),
      );
    }
  }
  await evaluate(`document.querySelector('.gallery-item').click()`);
  assert.equal(
    await evaluate(`document.querySelector('#gallery-dialog').open`),
    true,
    "Photo viewer opens",
  );
  await evaluate(`document.querySelector('#gallery-dialog-image').decode()`, {
    awaitPromise: true,
  });
  assert.equal(
    await evaluate(
      `document.querySelector('#gallery-dialog-image').naturalWidth > 0`,
    ),
    true,
    "Full photo loads",
  );
  await evaluate(`document.querySelector('#gallery-dialog button').click()`);
  assert.equal(
    await evaluate(`document.querySelector('#gallery-dialog').open`),
    false,
    "Photo viewer closes",
  );
  const aquaChecks = VERIFY_AQUA ? await verifyAqua() : null;
  assert.equal(pageErrors.length, 0, "No page errors");

  console.log(
    JSON.stringify(
      {
        base: BASE,
        chrome: CHROME,
        loginProbe,
        loginStatus: loginResult,
        probe,
        chartAfterTab,
        layouts,
        aquaChecks,
        consoleErrors: consoleLog.filter(
          (c) => c.type === "error" || c.type === "warning",
        ),
        pageErrors,
        screenshot: shotPath,
      },
      null,
      2,
    ),
  );
}

main()
  .then(async () => {
    try {
      ws?.close();
    } catch {
      /* bỏ qua */
    }
    browser.kill();
    await sleep(300);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("UI smoke thất bại:", err.stack || err.message);
    if (consoleLog.length)
      console.error("console:", JSON.stringify(consoleLog.slice(-20), null, 2));
    if (pageErrors.length)
      console.error(
        "pageErrors:",
        JSON.stringify(pageErrors.slice(-20), null, 2),
      );
    try {
      ws?.close();
    } catch {
      /* bỏ qua */
    }
    browser.kill();
    await sleep(200);
    process.exit(1);
  });
