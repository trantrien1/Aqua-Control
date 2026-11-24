/**
 * Chụp ảnh giao diện thật (Chrome headless qua CDP) để đưa vào hồ sơ kiểm thử.
 * Không cần Playwright. Node 24 có sẵn WebSocket + fetch.
 *
 *   node tools/capture-shots.mjs --base http://20.249.9.173 \
 *        --username baocao --password baocao123 --out docs/screenshots/ket-qua
 *
 * Ảnh tạo ra: login.png, dashboard-desktop.png, dashboard-mobile.png, admin.png
 * Ảnh admin chụp sau khi đăng nhập lại bằng tài khoản quản trị (nếu --admin-user có).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argOf("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const USERNAME = argOf("username", "admin");
const PASSWORD = argOf("password", "beca123");
const ADMIN_USER = argOf("admin-user", "admin");
const ADMIN_PASS = argOf("admin-pass", "beca123");
const OUT_DIR = path.resolve(argOf("out", "docs/screenshots/ket-qua"));
const PORT = Number(argOf("port", "9334"));
const HOST_IP = argOf("host-ip", null);
const CHROME =
  argOf("chrome", null) ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error("Không tìm thấy Chrome/Edge. Truyền --chrome <đường dẫn>.");
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDataDir = path.join(OUT_DIR, ".profile");

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
    ...(HOST_IP
      ? [`--host-resolver-rules=MAP ${new URL(BASE).hostname} ${HOST_IP}`]
      : []),
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

let ws = null;
let nextId = 1;
const pending = new Map();
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
    }, 25000);
  });
}

async function waitForTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome chưa lên */
    }
    await sleep(250);
  }
  throw new Error("Không kết nối được Chrome DevTools.");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(`WebSocket: ${e.message || "lỗi"}`)));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else ok(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        pageErrors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
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
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

function waitForLoad(timeout = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
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

async function shot(name, { full = true } = {}) {
  if (full) {
    const height = await evaluate(
      "Math.min(4000, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight))",
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: await evaluate("window.innerWidth"),
      height: height || 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(250);
  }
  const png = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(png.data, "base64"));
  return file;
}

async function loginAs(user, pass) {
  const status = await evaluate(
    `fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(pass)} }) }).then(r => r.status)`,
    { awaitPromise: true },
  );
  return status;
}

async function main() {
  const wsUrl = await waitForTarget();
  await connect(wsUrl);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const shots = {};

  // 1. Trang đăng nhập
  await send("Page.navigate", { url: `${BASE}/login` });
  await waitForLoad();
  await sleep(700);
  shots.login = await shot("login.png", { full: false });

  // 2. Đăng nhập khách hàng + dashboard
  const customerLogin = await loginAs(USERNAME, PASSWORD);
  await send("Page.navigate", { url: `${BASE}/` });
  await waitForLoad();
  await sleep(3500); // chờ SSE + telemetry
  const role = await evaluate(`fetch('/api/me').then(r => r.json()).then(m => m.role).catch(() => null)`, {
    awaitPromise: true,
  });
  const probe = await evaluate(`(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    return {
      path: location.pathname,
      metrics: [...document.querySelectorAll('.metric')].map(el => ({
        label: el.querySelector('.metric__label')?.textContent?.trim(),
        value: el.querySelector('.metric__num')?.textContent?.trim(),
        unit: el.querySelector('.metric__unit')?.textContent?.trim() ?? '',
        status: el.dataset.status,
      })),
      pumps: [...document.querySelectorAll('.pump')].map(el => ({
        title: el.querySelector('.pump__title')?.textContent?.trim(),
        state: el.querySelector('.pump__state')?.textContent?.trim(),
      })),
      connection: text('#conn-text'),
      device: text('#device-select option:checked'),
      freshness: text('#sensor-freshness'),
    };
  })()`);

  if (role === "admin") {
    await send("Page.navigate", { url: `${BASE}/admin` });
    await waitForLoad();
    await sleep(1500);
    shots.admin = await shot("admin.png");
  } else {
    shots["dashboard-desktop"] = await shot("dashboard-desktop.png");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await send("Page.navigate", { url: `${BASE}/` });
    await waitForLoad();
    await sleep(2500);
    shots["dashboard-mobile"] = await shot("dashboard-mobile.png");
  }

  // 3. Ảnh trang quản trị: đăng nhập lại bằng tài khoản admin
  const adminLogin = await loginAs(ADMIN_USER, ADMIN_PASS);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/admin` });
  await waitForLoad();
  await sleep(1200);
  shots.admin = await shot("admin.png");

  console.log(
    JSON.stringify({ base: BASE, customerLogin, adminLogin, role, probe, shots, pageErrors }, null, 2),
  );
}

main()
  .then(async () => {
    try {
      ws?.close();
    } catch {}
    browser.kill();
    await sleep(300);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Chụp ảnh thất bại:", err.stack || err.message);
    if (pageErrors.length) console.error(JSON.stringify(pageErrors.slice(-10), null, 2));
    try {
      ws?.close();
    } catch {}
    browser.kill();
    await sleep(200);
    process.exit(1);
  });
