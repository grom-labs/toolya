import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { enableAdb } from "./goggles";
import { stat } from "./stat";
import { fetchLatestRelease, installFromRelease, type Release } from "./natartos";
import { connectAdb, readUsage, run, runInDir, setUsbMode, USB_CFG, setSelinux, getSelinux, natartosStatus, natartosSafe, pushFile, pullFile, BG_PATH } from "./adb";
import { toScreenBmp, previewInto, bgraToCanvas } from "./image";
import type { Adb } from "@yume-chan/adb";

const $ = (id: string) => document.getElementById(id)!;
const logEl = $("log");
function log(s: string) {
  logEl.textContent += s + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

let adb: Adb | null = null;
let term: Terminal | null = null;

// Demo mode (set by the Worker when DRY_RUN): simulate enable/connect, no real device,
// no stats — just to preview the UI. See worker/src/index.ts.
const DRY = !!(window as unknown as { __TOOLYA_DRY_RUN__?: unknown }).__TOOLYA_DRY_RUN__;

// First-run risk disclaimer — shown until acknowledged (stored per browser).
if (!localStorage.getItem("toolya.ack")) {
  const modal = $("disclaimer");
  modal.hidden = false;
  const ck = $("disc-ck") as HTMLInputElement;
  const ok = $("disc-ok") as HTMLButtonElement;
  ck.addEventListener("change", () => {
    ok.disabled = !ck.checked;
  });
  ok.addEventListener("click", () => {
    try {
      localStorage.setItem("toolya.ack", "1");
    } catch {
      /* ignore */
    }
    stat("disclaimer_ok");
    modal.hidden = true;
  });
}

// top of the funnel: a landing. (decline = page_view − disclaimer_ok, no separate event)
stat("page_view");

// live rooted-count badge (from the Worker's Analytics Engine query; optional)
let rootedN: number | null = null;
function showRooted(n: number) {
  rootedN = n;
  const el = $("rooted");
  el.innerHTML = `🔓 <b>${n.toLocaleString()}</b> rooted`;
  el.hidden = false;
}
fetch("/api/rooted")
  .then((r) => r.json())
  .then((d: { rooted?: number }) => {
    if (typeof d.rooted === "number" && d.rooted > 0) showRooted(d.rooted);
  })
  .catch(() => {
    /* badge is optional */
  });

// success flourish after root is confirmed
function rootFx() {
  const fx = $("root-fx");
  fx.classList.remove("go");
  void fx.offsetWidth; // reflow so the animation restarts
  fx.classList.add("go");
  const term = $("term");
  term.classList.remove("rooted-glow");
  void term.offsetWidth;
  term.classList.add("rooted-glow");
  if (rootedN !== null && !DRY) showRooted(rootedN + 1); // optimistic bump (real roots only)
}

// crypto donation address (EVM, any chain) — copy button in the Support card
const CRYPTO_ADDR = "0x5182b19b01714C64811AeC6C59A0880C6F24528d";
$("evm-copy").addEventListener("click", async () => {
  const btn = $("evm-copy");
  const prev = btn.textContent;
  try {
    await navigator.clipboard.writeText(CRYPTO_ADDR);
    btn.textContent = "copied ✓";
  } catch {
    btn.textContent = "copy failed";
  }
  setTimeout(() => {
    btn.textContent = prev;
  }, 1600);
});

function setStatus(text: string, cls = "") {
  const el = $("status");
  el.textContent = text;
  el.dataset.state = cls === "ok" ? "active" : cls === "err" ? "error" : "idle";
}
function btn(id: string, disabled: boolean) {
  ($(id) as HTMLButtonElement).disabled = disabled;
}
// Shift the primary (highlighted) button along the Enable → Connect flow.
function setPrimary(which: "enable" | "connect" | "none") {
  $("btn-enable").classList.toggle("primary", which === "enable");
  $("btn-connect").classList.toggle("primary", which === "connect");
}
// Post-root guidance banner (next steps + adb-from-desktop).
function showSuccess() {
  const el = $("success");
  el.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' +
    "<div><h3>Rooted — you're in 🎉</h3>" +
    "<p>What now? Type commands in the <b>terminal</b> above, or set up <b>natartos</b> for persistent mods. " +
    "Prefer your computer's terminal? The goggles now speak adb over USB — run <code>adb devices</code>, then <code>adb shell</code>.</p>" +
    '<div class="srow">' +
    '<button class="btn sm" id="su-term" type="button">↑ Go to terminal</button>' +
    '<button class="btn sm tonal" id="su-nat" type="button">Set up natartos →</button>' +
    "</div></div>" +
    '<button class="x" id="success-x" type="button" aria-label="dismiss">×</button>';
  el.hidden = false;
  $("success-x").addEventListener("click", () => {
    el.hidden = true;
  });
  $("su-term").addEventListener("click", () => {
    $("term").scrollIntoView({ behavior: "smooth", block: "center" });
    term?.focus();
  });
  $("su-nat").addEventListener("click", () => navTo("/natartos"));
}

// Map raw WebUSB/adb errors to plain-language guidance.
function friendlyError(e: unknown): string {
  const err = e as { name?: string; message?: string };
  const name = err?.name ?? "";
  const msg = err?.message ?? String(e);
  if (name === "NotFoundError" || /no device (selected|found|chosen)/i.test(msg))
    return "No goggles selected. Plug them in and pick the device in the browser prompt.";
  if (/claim|in ?use|access denied|busy/i.test(msg))
    return "Couldn't claim the USB interface. Close any running adb server; on Windows install the WinUSB driver (Zadig).";
  if (name === "SecurityError" || /secure context|permission|denied/i.test(msg))
    return "Blocked by the browser. Use Chrome/Edge over https or http://localhost.";
  if (/unauthor|auth|rejected|credential/i.test(msg))
    return "The goggles rejected the connection. Try reconnecting; the device may need re-pairing.";
  if (isDisconnect(e)) return "Connection lost — the goggles disconnected.";
  return msg;
}

function isDisconnect(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? "";
  return /disconnect|lost|closed|no such device|unavailable|detached|ENOENT/i.test(msg);
}

// Coarse failure bucket for telemetry (where rooting broke) — no raw messages.
function classifyErr(e: unknown): string {
  const err = e as { name?: string; message?: string };
  const name = err?.name ?? "";
  const msg = err?.message ?? String(e);
  if (/webusb not available/i.test(msg)) return "no_webusb";
  if (name === "NotFoundError" || /no device (selected|found|chosen)|no goggles selected/i.test(msg)) return "no_device";
  if (/claim|in ?use|access denied|busy/i.test(msg)) return "claim";
  if (name === "SecurityError" || /secure context/i.test(msg)) return "secure";
  if (/unauthor|auth|rejected|credential/i.test(msg)) return "auth";
  if (/re-enumerate|cmd_id/i.test(msg)) return "no_reenum";
  if (isDisconnect(e)) return "disconnect";
  return "other";
}

// Report an adb-op error in plain language; if it's a drop, reset to disconnected.
function reportAdbError(ctx: string, e: unknown) {
  log(`${ctx}: ${friendlyError(e)}`);
  if (isDisconnect(e)) void disconnect();
}

// WebUSB needs a secure context (https or localhost). Over http://<LAN-IP> the
// browser disables navigator.usb — tell the user instead of failing cryptically.
const canUsb = DRY || (window.isSecureContext && !!navigator.usb);
if (!canUsb) {
  const n = $("notice");
  n.hidden = false;
  n.innerHTML =
    "WebUSB needs a secure context. Open this page over <code>https</code> or " +
    "<code>http://localhost</code> on the machine the goggles are plugged into. " +
    "Over <code>http://&lt;LAN-IP&gt;</code> the browser disables USB.";
  btn("btn-enable", true);
  btn("btn-connect", true);
}

// --- view router: /app (root tool) vs /natartos (on-device mods) — same page, one connection ---
function showView(name: "root" | "natartos") {
  $("view-root").hidden = name !== "root";
  $("view-natartos").hidden = name !== "natartos";
}
function applyRoute(smooth: boolean) {
  const nat = location.pathname.replace(/\/+$/, "") === "/natartos";
  showView(nat ? "natartos" : "root");
  // natartos: scroll to its section (not the console at top); root: back to top
  if (nat) $("view-natartos").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  else if (smooth) scrollTo({ top: 0, behavior: "smooth" });
}
function navTo(path: string) {
  history.pushState({}, "", path);
  applyRoute(true);
}
$("to-natartos").addEventListener("click", (e) => { e.preventDefault(); navTo("/natartos"); });
$("to-root").addEventListener("click", (e) => { e.preventDefault(); navTo("/app"); });
addEventListener("popstate", () => applyRoute(false));
applyRoute(false);

$("btn-enable").addEventListener("click", async () => {
  stat("enable_start");
  if (DRY) {
    log("enable ADB — simulated (demo mode).");
    stat("enable_ok");
    setPrimary("connect");
    return;
  }
  try {
    await enableAdb(log);
    stat("enable_ok");
    setPrimary("connect"); // enable done → nudge the user to Connect
  } catch (e) {
    stat("enable_fail", { stage: classifyErr(e) });
    log("enable: " + friendlyError(e));
  }
});

$("btn-connect").addEventListener("click", async () => {
  if (DRY) {
    fakeConnect();
    return;
  }
  try {
    log("connecting adb…");
    setStatus("connecting…");
    adb = await connectAdb();
    log("connected: " + adb.banner.model + " (root shell)");
    setStatus("connected · root", "ok");
    $("devinfo").textContent = `${adb.banner.model} · ${adb.banner.product}`;
    $("usage-hdr").hidden = false;
    btn("btn-usage", false);
    btn("btn-disconnect", false);
    btn("btn-connect", true);
    btn("usb-adb", false);
    btn("usb-rndis", false);
    btn("selinux-perm", false);
    btn("selinux-enf", false);
    btn("nat-refresh", false);
    ($("nat-safe") as HTMLInputElement).disabled = false;
    updateNatInstall();
    btn("scr-grab", false);
    if (bgBytes) btn("bg-apply", false);
    void startTerminal(adb);
    stat("connect_ok");
    rootFx();
    setPrimary("none");
    showSuccess();
    $("nat-sec-state").textContent = "ready";
    void refreshSelinux();
    void refreshNatartos();
    await refreshUsage();
  } catch (e) {
    stat("connect_fail", { reason: classifyErr(e) });
    log("connect: " + friendlyError(e));
    setStatus("connect failed", "err");
  }
});

// Demo-mode connect: paint the connected UI with sample data, no real device.
function fakeConnect() {
  log("connecting adb… (demo mode)");
  adb = null; // stays null — real adb ops remain inert
  setStatus("connected · root", "ok");
  $("devinfo").textContent = "E3T zv902 · demo";
  $("usage-hdr").hidden = false;
  $("stat-power").textContent = "123";
  $("stat-motor").textContent = "957";
  btn("btn-usage", false);
  btn("btn-disconnect", false);
  btn("btn-connect", true);
  btn("usb-adb", false);
  btn("usb-rndis", false);
  btn("selinux-perm", false);
  btn("selinux-enf", false);
  btn("nat-refresh", false);
  ($("nat-safe") as HTMLInputElement).disabled = false;
  updateNatInstall();
  btn("scr-grab", false);
  if (bgBytes) btn("bg-apply", false);
  $("selinux-state").textContent = "Enforcing";
  $("nat-status").textContent = "not installed";
  $("nat-boot").textContent = "0";
  startFakeTerminal();
  setPrimary("none");
  showSuccess();
  $("nat-sec-state").textContent = "ready (demo)";
  rootFx();
  log("connected: E3T zv902 (root shell) — demo mode, no real device");
}

function startFakeTerminal() {
  const t = new Terminal({
    fontSize: 13,
    cursorBlink: true,
    fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
    theme: { background: "#0a0c10", foreground: "#e7e9ee", cursor: "#5cc8ff" },
  });
  term = t;
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.open($("term"));
  fit.fit();
  addEventListener("resize", () => fit.fit());
  let line = "";
  const prompt = () => t.write("\r\n\x1b[36m/\x1b[0m $ ");
  t.writeln("toolya root shell (demo) — type anything; no real device is attached.");
  prompt();
  t.focus();
  t.onData((d) => {
    for (const ch of d) {
      if (ch === "\r") {
        t.write("\r\n");
        if (line.trim()) t.write("\x1b[90m(demo) no device — this is a UI preview\x1b[0m\r\n");
        line = "";
        prompt();
      } else if (ch === "\x7f") {
        if (line) { line = line.slice(0, -1); t.write("\b \b"); }
      } else if (ch >= " ") {
        line += ch;
        t.write(ch);
      }
    }
  });
}

$("btn-disconnect").addEventListener("click", () => void disconnect());
$("usb-adb").addEventListener("click", () => void switchUsb("adb"));
$("usb-rndis").addEventListener("click", () => void switchUsb("rndis"));

async function refreshSelinux() {
  if (!adb) return;
  try {
    $("selinux-state").textContent = await getSelinux(adb);
  } catch { /* leave as-is */ }
}
async function toggleSelinux(mode: "permissive" | "enforcing") {
  if (!adb) return;
  if (mode === "permissive" &&
      !confirm("Set SELinux permissive? This pokes kernel memory (devmem). Session-only — resets to enforcing on reboot.")) return;
  log(`SELinux → ${mode}…`);
  try {
    const now = await setSelinux(adb, mode);
    $("selinux-state").textContent = now;
    log(`SELinux: ${now}`);
    if (!now.toLowerCase().startsWith(mode.slice(0, 4))) {
      log("SELinux: no known selinux_state address matched (new kernel build?) — ask the researcher to add its address.");
    }
  } catch (e) {
    reportAdbError("selinux", e);
  }
}
$("selinux-perm").addEventListener("click", () => void toggleSelinux("permissive"));
$("selinux-enf").addEventListener("click", () => void toggleSelinux("enforcing"));

// --- natartos section ---
async function refreshNatartos() {
  if (!adb) return;
  try {
    const s = await natartosStatus(adb);
    $("nat-status").textContent = s.installed ? s.version : "not installed";
    $("nat-boot").textContent = s.bootcount;
    ($("nat-safe") as HTMLInputElement).checked = s.disabled;
  } catch {
    /* leave as-is */
  }
}
$("nat-refresh").addEventListener("click", () => void refreshNatartos());
$("nat-safe").addEventListener("change", async (e) => {
  if (!adb) return;
  const on = (e.target as HTMLInputElement).checked;
  log(`natartos safe mode → ${on ? "ON (mods disabled next boot)" : "OFF (mods enabled + bootcount reset)"}`);
  try {
    await natartosSafe(adb, on);
  } catch (err) {
    reportAdbError("natartos safe", err);
  }
});
// natartos install: gated on a real release existing (none yet → stays inert).
let natRelease: Release | null = null;
function updateNatInstall() {
  btn("nat-install", !(adb && natRelease));
}
fetchLatestRelease().then((rel) => {
  natRelease = rel;
  const sel = $("nat-ver") as HTMLSelectElement;
  sel.innerHTML = rel
    ? `<option>${rel.tag_name}${rel.prerelease ? " (pre)" : ""}</option>`
    : "<option>no releases yet</option>";
  updateNatInstall();
});
$("nat-install").addEventListener("click", async () => {
  if (!natRelease) return;
  if (!confirm(`Install natartos ${natRelease.tag_name}? Writes to /vendor and survives reboot. A boot-loop auto-disables mods (brick-prevention).`)) return;
  if (DRY) {
    log(`demo: would install natartos ${natRelease.tag_name} (no real device).`);
    return;
  }
  if (!adb) return;
  btn("nat-install", true);
  log(`installing natartos ${natRelease.tag_name}…`);
  try {
    await installFromRelease(adb, natRelease, log);
    void refreshNatartos();
  } catch (e) {
    reportAdbError("natartos install", e);
  } finally {
    updateNatInstall();
  }
});

// --- screen (LiveView frame grab over adb) ---
const scrPath = $("scr-path") as HTMLInputElement;
let scrTimer: ReturnType<typeof setInterval> | null = null;

const FRAME_BYTES = 1920 * 1080 * 4; // 8294400, raw BGRA

async function grabScreen() {
  if (!adb) return;
  try {
    // 1. trigger the frame hook (hook_debug.so dumps the current DMA-buf on SIGWINCH).
    //    hook v4 uses screencap.log as a global debug sink (every LD_PRELOAD'd process
    //    appends to it), so we don't gate on log=="OK" — we gate on the frame itself.
    await run(adb, "kill -WINCH $(pidof dji_glasses)");
    await new Promise((r) => setTimeout(r, 300));
    // 2. pull the raw BGRA frame; a correct 8294400-byte frame IS the success signal
    const bytes = await pullFile(adb, scrPath.value.trim());
    if (bytes.length !== FRAME_BYTES) {
      // frame wrong/missing — surface the hook's log tail to diagnose (hook loaded?
      // dji_glasses running? GOT patched?)
      let tail = "";
      try {
        tail = (await run(adb, "tail -c 400 /data/local/tmp/screencap.log")).trim();
      } catch { /* log may not exist */ }
      log(`screen: got ${bytes.length}B (expected ${FRAME_BYTES}). hook log tail: ${tail || "(empty)"}`);
      stopAuto();
      return;
    }
    bgraToCanvas(bytes, $("scr-canvas") as HTMLCanvasElement);
    log(`screen frame ok (${(bytes.length / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    reportAdbError("screen grab", e);
    stopAuto();
  }
}
function stopAuto() {
  if (scrTimer) {
    clearInterval(scrTimer);
    scrTimer = null;
  }
  ($("scr-auto") as HTMLInputElement).checked = false;
}
$("scr-grab").addEventListener("click", () => void grabScreen());
$("scr-auto").addEventListener("change", (e) => {
  if ((e.target as HTMLInputElement).checked) {
    scrTimer = setInterval(() => void grabScreen(), 1000);
  } else {
    stopAuto();
  }
});

// --- background image converter ---
const bgFile = $("bg-file") as HTMLInputElement;
const bgFit = $("bg-fit") as HTMLSelectElement;
let bgBytes: Uint8Array<ArrayBuffer> | null = null;

async function bgUpdate() {
  const f = bgFile.files?.[0];
  if (!f) return;
  const fit = bgFit.value as "cover" | "contain";
  try {
    await previewInto($("bg-preview") as HTMLCanvasElement, f, fit);
    bgBytes = await toScreenBmp(f, fit);
    btn("bg-download", false);
    btn("bg-apply", !adb);
    log(`background ready: ${(bgBytes.length / 1e6).toFixed(1)} MB BMP (1920×1080)`);
  } catch (e) {
    log("image error: " + (e as Error).message);
  }
}
bgFile.addEventListener("change", () => void bgUpdate());
bgFit.addEventListener("change", () => void bgUpdate());

$("bg-download").addEventListener("click", () => {
  if (!bgBytes) return;
  const url = URL.createObjectURL(new Blob([bgBytes], { type: "image/bmp" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "screendesk_1920.bmp";
  a.click();
  URL.revokeObjectURL(url);
});

$("bg-apply").addEventListener("click", async () => {
  if (!adb || !bgBytes) return;
  if (!confirm(`Write background to the goggles (${BG_PATH})?`)) return;
  log("pushing background…");
  try {
    await pushFile(adb, BG_PATH, bgBytes);
    log("background written — a UI refresh or reboot may be needed to show it.");
  } catch (e) {
    reportAdbError("background apply", e);
  }
});

async function switchUsb(mode: "adb" | "rndis") {
  if (!adb) return;
  if (!confirm(`Switch USB to ${mode}? This re-enumerates USB and drops the connection.`)) return;
  log(`switching USB → ${mode} (sys.usb.config = ${USB_CFG[mode]})…`);
  await setUsbMode(adb, mode);
  if (mode === "rndis") {
    log("RNDIS requested — on this machine bring up usb0:");
    log("  sudo ip addr add 192.168.60.1/24 dev usb0");
    log("  sudo ip link set usb0 up");
    log("  device: 192.168.60.2");
  }
  log("USB re-enumerated — connection dropped.");
  await disconnect();
}
$("btn-usage").addEventListener("click", () => void refreshUsage());
$("btn-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("log").textContent ?? "");
    log("(log copied)");
  } catch {
    log("clipboard unavailable");
  }
});

async function disconnect() {
  try { term?.dispose(); } catch { /* ignore */ }
  term = null;
  $("term").innerHTML = "";
  try { await adb?.close(); } catch { /* ignore */ }
  adb = null;
  updateNatInstall();
  setStatus("not connected");
  $("success").hidden = true;
  $("nat-sec-state").textContent = "connect first";
  setPrimary("connect"); // ready to reconnect
  $("devinfo").textContent = "";
  $("usage-hdr").hidden = true;
  $("stat-power").textContent = "—";
  $("stat-motor").textContent = "—";
  btn("btn-usage", true);
  btn("btn-disconnect", true);
  btn("usb-adb", true);
  btn("usb-rndis", true);
  stopAuto();
  btn("scr-grab", true);
  btn("bg-apply", true);
  if (canUsb) btn("btn-connect", false);
  log("disconnected");
}

async function refreshUsage() {
  if (!adb) return;
  log("reading /data/glasses_statistics.json …");
  try {
    const u = await readUsage(adb);
    $("stat-power").textContent = u.powerOns?.toLocaleString() ?? "?";
    $("stat-motor").textContent = u.motorStarts?.toLocaleString() ?? "?";
  } catch (e) {
    reportAdbError("usage", e);
  }
}

// The G3 interactive shell (even shell_v2 PTY) echoes input but returns no output.
// So the terminal is a line editor inside xterm — you type directly into it — backed
// by working one-shot command mode, with cwd tracked so `cd` persists.
const NOISE = /\[sec_debug_state:[^\]]*\][^\r\n]*\r?\n?/g;

function startTerminal(adb: Adb) {
  const t = new Terminal({
    fontSize: 13,
    convertEol: false,
    cursorBlink: true,
    fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
    theme: { background: "#0a0c10", foreground: "#e7e9ee", cursor: "#5cc8ff" },
  });
  term = t;
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.open($("term"));
  fit.fit();
  addEventListener("resize", () => fit.fit());

  let cwd = "/";
  let line = "";
  let busy = false;
  const prompt = () => t.write(`\r\n\x1b[36m${cwd}\x1b[0m $ `);
  t.writeln("toolya root shell — type a command and press Enter. (cd persists.)");
  prompt();
  t.focus();

  t.onData(async (data) => {
    if (busy) return;
    for (const ch of data) {
      if (ch === "\r") {
        t.write("\r\n");
        const cmd = line;
        line = "";
        if (!cmd.trim()) { prompt(); return; }
        busy = true;
        try {
          const { output, cwd: nc } = await runInDir(adb, cmd, cwd);
          cwd = nc;
          const clean = output.replace(NOISE, "").replace(/\n/g, "\r\n");
          if (clean.trim()) t.write(clean.endsWith("\r\n") ? clean : clean + "\r\n");
        } catch (err) {
          t.write(`\x1b[31m${friendlyError(err)}\x1b[0m\r\n`);
          if (isDisconnect(err)) { setStatus("disconnected", "err"); void disconnect(); return; }
        } finally {
          busy = false;
        }
        prompt();
        return;
      } else if (ch === "\x7f") {
        if (line.length) { line = line.slice(0, -1); t.write("\b \b"); }
      } else if (ch === "\x03") {
        line = "";
        t.write("^C");
        prompt();
      } else if (ch >= " ") {
        line += ch;
        t.write(ch);
      }
    }
  });
  log("terminal ready — root shell");
}
