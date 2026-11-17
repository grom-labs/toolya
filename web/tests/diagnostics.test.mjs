import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setImmediate as tick } from "node:timers/promises";

const temporary = await mkdtemp(path.join(tmpdir(), "toolya-diagnostics-tests-"));
let javascript;
try {
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
    "--ignoreConfig", "--noCheck", "--target", "ES2022", "--module", "ESNext", "--outDir", temporary,
    fileURLToPath(new URL("../src/diagnostics.ts", import.meta.url)),
  ], { windowsHide: true });
  javascript = await readFile(path.join(temporary, "diagnostics.js"), "utf8");
} finally {
  const parent = await realpath(tmpdir()), target = await realpath(temporary);
  assert.ok(target.startsWith(parent + path.sep));
  await rm(target, { recursive: true, force: true });
}
const { collectDiagnostics, collectAdbDiagnostics, DIAGNOSTIC_QUERIES } =
  await import("data:text/javascript;base64," + Buffer.from(javascript).toString("base64"));

const fixture = {
  model: "E3T zv902", abi: "arm64-v8a", android: "12", build: "PD1A.180720.031",
  usb: "acm,adb", uptime: "123.50 200.00", load: "0.25 0.50 0.75 1/400 1234",
  memory: "MemTotal:        4096 kB\nMemAvailable:    2048 kB\nIgnored: SERIAL_SECRET\n",
  manifest: JSON.stringify({ natartos_version: "0.1.0", serial: "SERIAL_SECRET", secret: "PRIVATE_KEY" }),
  disabled: "no", loader: "yes",
};
const now = () => new Date("2026-11-17T00:00:00Z");
const readFixture = (overrides = {}) => async key => ({ ...fixture, ...overrides })[key];

function processDouble(text, { oversized = false, pending = false } = {}) {
  const counts = { kills: 0, cancels: 0, releases: 0 };
  const stream = new ReadableStream({
    start(controller) {
      if (pending) return;
      controller.enqueue(oversized ? new Uint8Array(65537) : new TextEncoder().encode(text));
      controller.close();
    },
  });
  return {
    counts,
    proc: {
      exited: Promise.resolve(),
      kill() { counts.kills++; },
      output: { getReader() {
        const reader = stream.getReader();
        return {
          read: () => reader.read(),
          cancel() { counts.cancels++; return reader.cancel(); },
          releaseLock() { counts.releases++; reader.releaseLock(); },
        };
      } },
    },
  };
}
const lookup = new Map(Object.entries(DIAGNOSTIC_QUERIES).map(([key, command]) => [command, key]));

test("normalizes only allowlisted fields with explicit sources", async () => {
  const commands = [];
  const report = await collectDiagnostics(async (key, command) => {
    commands.push(command); return fixture[key];
  }, { now });
  assert.equal(report.schema, "toolya-diagnostics-v1");
  assert.equal(report.generatedAt, now().toISOString());
  assert.equal(report.device.model.value, "E3T zv902");
  assert.equal(report.device.buildId.source, "ro.build.display.id");
  assert.deepEqual(report.resources.memoryKiB.value, { total: 4096, available: 2048 });
  assert.deepEqual(report.resources.loadAverage.value, [0.25, 0.5, 0.75]);
  assert.equal(report.resources.uptimeSeconds.value, 123.5);
  assert.equal(report.modStatus.loaderActive.value, true);
  assert.equal(report.temperatures.value, null);
  assert.deepEqual(commands, Object.values(DIAGNOSTIC_QUERIES));
  assert.doesNotMatch(JSON.stringify(report), /SERIAL_SECRET|PRIVATE_KEY|Ignored/);
});

test("malformed values and command errors never enter the report", async () => {
  const report = await collectDiagnostics(async key => {
    if (key === "abi") throw new Error("PRIVATE_KEY /private/path");
    if (key === "model") return "E3T zv902\nSERIAL_SECRET";
    if (key === "build") return "serial=SERIAL_SECRET";
    return fixture[key];
  });
  assert.equal(report.device.model.status, "invalid");
  assert.equal(report.device.abi.status, "unavailable");
  assert.equal(report.device.buildId.value, null);
  assert.doesNotMatch(JSON.stringify(report), /SERIAL_SECRET|PRIVATE_KEY|private\/path/);
});

test("missing optional memory data and unknown USB mode stay explicit", async () => {
  const report = await collectDiagnostics(readFixture({ memory: "MemTotal: 4096 kB", usb: "unavailable", manifest: "" }));
  assert.deepEqual(report.resources.memoryKiB.value, { total: 4096, available: null });
  assert.equal(report.device.usbMode.status, "unavailable");
  assert.equal(report.modStatus.version.status, "unavailable");
});

test("rejects invalid numbers, contradictory memory and unknown booleans", async () => {
  const report = await collectDiagnostics(readFixture({
    uptime: "Infinity 0", load: "-1 0 0 1/2 3", memory: "MemTotal: 10 kB\nMemAvailable: 20 kB",
    disabled: "yes and SERIAL_SECRET", manifest: "not JSON",
  }));
  assert.equal(report.resources.uptimeSeconds.status, "invalid");
  assert.equal(report.resources.loadAverage.status, "invalid");
  assert.equal(report.resources.memoryKiB.status, "invalid");
  assert.equal(report.modStatus.disabled.status, "invalid");
  assert.equal(report.modStatus.version.status, "invalid");
});

test("ADB adapter runs fixed queries and closes each process and reader", async () => {
  const processes = [];
  const adb = { subprocess: { noneProtocol: { spawn: async (command, signal) => {
    assert.ok(lookup.has(command)); assert.equal(signal.aborted, false);
    const p = processDouble(fixture[lookup.get(command)]); processes.push(p); return p.proc;
  } } } };
  const report = await collectAdbDiagnostics(adb, { now });
  await tick();
  assert.equal(report.device.model.value, "E3T zv902");
  assert.equal(processes.length, 11);
  for (const p of processes) assert.deepEqual(p.counts, { kills: 1, cancels: 1, releases: 1 });
});

test("disconnect aborts a pending read and stops all subsequent queries", async () => {
  const controller = new AbortController(), p = processDouble("", { pending: true });
  let spawns = 0;
  const adb = { subprocess: { noneProtocol: { spawn: async () => { spawns++; return p.proc; } } } };
  const pending = collectAdbDiagnostics(adb, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await tick();
  assert.equal(spawns, 1);
  assert.deepEqual(p.counts, { kills: 1, cancels: 1, releases: 1 });
});

test("query timeout returns unavailable and closes a late process", async () => {
  let resolveSpawn;
  const delayed = new Promise(resolve => { resolveSpawn = resolve; });
  const late = processDouble(fixture.model);
  const adb = { subprocess: { noneProtocol: { spawn: async command => {
    if (lookup.get(command) === "model") return delayed;
    return processDouble(fixture[lookup.get(command)]).proc;
  } } } };
  const report = await collectAdbDiagnostics(adb, { queryTimeoutMs: 10 });
  assert.equal(report.device.model.status, "unavailable");
  resolveSpawn(late.proc); await tick();
  assert.equal(late.counts.kills, 1); assert.equal(late.counts.cancels, 0);
});

test("oversized output is discarded and its process is closed", async () => {
  const huge = processDouble("", { oversized: true });
  const adb = { subprocess: { noneProtocol: { spawn: async command =>
    lookup.get(command) === "model" ? huge.proc : processDouble(fixture[lookup.get(command)]).proc,
  } } };
  const report = await collectAdbDiagnostics(adb);
  await tick();
  assert.equal(report.device.model.value, null);
  assert.equal(report.device.model.status, "unavailable");
  assert.deepEqual(huge.counts, { kills: 1, cancels: 1, releases: 1 });
});

test("an unavailable manifest is distinguished from malformed JSON", async () => {
  const absent = await collectDiagnostics(readFixture({ manifest: "unavailable" }));
  const corrupt = await collectDiagnostics(readFixture({ manifest: "{broken" }));
  assert.equal(absent.modStatus.version.status, "unavailable");
  assert.equal(corrupt.modStatus.version.status, "invalid");
  // The production query suppresses missing/denied-file stderr and emits the
  // unavailable marker. Its device-side execution still needs a bench check.
  assert.match(DIAGNOSTIC_QUERIES.manifest, /2>\/dev\/null \|\| echo unavailable$/);
});

test("arbitrary identifier-shaped build strings are discarded", async () => {
  const report = await collectDiagnostics(readFixture({ build: "SERIAL_SECRET" }));
  assert.equal(report.device.buildId.status, "invalid");
  assert.doesNotMatch(JSON.stringify(report), /SERIAL_SECRET/);
});

test("abort observes the independent process.exited rejection", async () => {
  const controller = new AbortController(), p = processDouble("", { pending: true });
  let rejectExit;
  p.proc.exited = new Promise((_, reject) => { rejectExit = reject; });
  const adb = { subprocess: { noneProtocol: { spawn: async (_command, signal) => {
    signal.addEventListener("abort", () => rejectExit(new Error("process aborted")), { once: true });
    return p.proc;
  } } } };
  const pending = collectAdbDiagnostics(adb, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await tick();
  assert.deepEqual(p.counts, { kills: 1, cancels: 1, releases: 1 });
});
