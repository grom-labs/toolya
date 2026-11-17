// Structured, read-only support reports. No identifiers, raw logs or writes.
import type { Adb } from "@yume-chan/adb";

export const DIAGNOSTIC_QUERIES = {
  model: "getprop ro.product.model",
  abi: "getprop ro.product.cpu.abi",
  android: "getprop ro.build.version.release",
  build: "getprop ro.build.display.id",
  usb: "getprop sys.usb.config",
  uptime: "cat /proc/uptime",
  load: "cat /proc/loadavg",
  memory: "cat /proc/meminfo",
  manifest: "[ -r /vendor/natartos/manifest.json ] && cat /vendor/natartos/manifest.json 2>/dev/null || echo unavailable",
  disabled: "[ -f /data/.natartos_disabled ] && echo yes || echo no",
  loader: 'p=$(pidof dji_glasses); case "$p" in ""|*" "*) echo unavailable;; *) if [ -r "/proc/$p/maps" ]; then grep -q natartos_loader "/proc/$p/maps"; case $? in 0) echo yes;; 1) echo no;; *) echo unavailable;; esac; else echo unavailable; fi;; esac',
} as const;

type Query = keyof typeof DIAGNOSTIC_QUERIES;
interface Field<T> {
  value: T | null;
  status: "available" | "unavailable" | "invalid";
  source: string;
}
export interface DiagnosticOptions {
  signal?: AbortSignal;
  now?: () => Date;
  queryTimeoutMs?: number;
}

// Limit both time and received bytes, including after a delayed spawn. Cleanup
// failures never leak raw command output or create unhandled rejections.
async function readQuery(adb: Adb, command: string, options: DiagnosticOptions): Promise<string> {
  const controller = new AbortController();
  let proc: { kill(): void | PromiseLike<void> } | null = null;
  let reader: { cancel(): Promise<void>; releaseLock(): void } | null = null;
  const cleanup = (action: () => void | PromiseLike<void>) => {
    void (async () => { try { await action(); } catch { /* best-effort close */ } })();
  };
  const close = () => {
    const r = reader; reader = null;
    const p = proc; proc = null;
    if (r) cleanup(async () => { try { await r.cancel(); } finally { r.releaseLock(); } });
    if (p) cleanup(() => p.kill());
  };
  const forwardAbort = () => controller.abort();
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.queryTimeoutMs ?? 1500);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => { close(); reject(new Error("DIAGNOSTIC_QUERY_ABORTED")); };
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const task = (async () => {
    try {
      const process = await adb.subprocess.noneProtocol.spawn(command, controller.signal);
      proc = process;
      // ya-webadb rejects this promise on abort independently of output.read().
      void process.exited.catch(() => {});
      controller.signal.throwIfAborted();
      const output = process.output.getReader();
      reader = output;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await output.read();
        controller.signal.throwIfAborted();
        if (done) break;
        total += value.length;
        if (total > 65536) throw new Error("DIAGNOSTIC_OUTPUT_LIMIT");
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    } finally {
      close();
    }
  })();
  try {
    return await Promise.race([task, aborted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

function text(pattern: RegExp): (value: string) => string {
  return value => { if (!pattern.test(value)) throw new Error("INVALID_VALUE"); return value; };
}
function number(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("INVALID_NUMBER");
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) throw new Error("INVALID_NUMBER");
  return result;
}
function yesNo(value: string): boolean {
  if (value !== "yes" && value !== "no") throw new Error("INVALID_BOOLEAN");
  return value === "yes";
}

export async function collectDiagnostics(
  read: (query: Query, command: string) => Promise<string>,
  options: Pick<DiagnosticOptions, "signal" | "now"> = {},
) {
  const warnings: string[] = [];
  async function field<T>(query: Query, source: string, parse: (value: string) => T): Promise<Field<T>> {
    options.signal?.throwIfAborted();
    let raw: string;
    try { raw = (await read(query, DIAGNOSTIC_QUERIES[query])).trim(); }
    catch {
      options.signal?.throwIfAborted();
      warnings.push(`${query}:unavailable`);
      return { value: null, status: "unavailable", source };
    }
    options.signal?.throwIfAborted();
    if (!raw || raw === "unavailable") {
      warnings.push(`${query}:unavailable`);
      return { value: null, status: "unavailable", source };
    }
    try {
      if (raw.length > 65536) throw new Error("OUTPUT_LIMIT");
      return { value: parse(raw), status: "available", source };
    } catch {
      warnings.push(`${query}:invalid`);
      return { value: null, status: "invalid", source };
    }
  }
  const device = {
    model: await field("model", "ro.product.model", text(/^E3T zv902$/)),
    abi: await field("abi", "ro.product.cpu.abi", text(/^(arm64-v8a|armeabi-v7a|armeabi|x86_64|x86)$/)),
    androidVersion: await field("android", "ro.build.version.release", text(/^\d{1,2}(?:\.\d{1,3}){0,2}$/)),
    // Android build ID is reported as such; it is not asserted to be DJI firmware.
    buildId: await field("build", "ro.build.display.id", text(/^[A-Z0-9]{3,6}\.\d{6}\.\d{3}(?:\.[A-Z0-9]{1,8})?$/)),
    usbMode: await field("usb", "sys.usb.config", text(/^(acm,adb|rndis,mass_storage,bulk,acm,adb)$/)),
  };
  const resources = {
    uptimeSeconds: await field("uptime", "/proc/uptime", value => {
      const parts = value.split(/\s+/); if (parts.length !== 2) throw new Error("INVALID_UPTIME");
      number(parts[1]); return number(parts[0]);
    }),
    loadAverage: await field("load", "/proc/loadavg", value => {
      const parts = value.split(/\s+/); if (parts.length !== 5) throw new Error("INVALID_LOAD");
      return parts.slice(0, 3).map(number);
    }),
    memoryKiB: await field("memory", "/proc/meminfo", value => {
      const total = /^MemTotal:\s+(\d+) kB\s*$/m.exec(value);
      const available = /^MemAvailable:\s+(\d+) kB\s*$/m.exec(value);
      if (!total) throw new Error("INVALID_MEMORY");
      const totalKiB = number(total[1]);
      const availableKiB = available ? number(available[1]) : null;
      if (!totalKiB || (availableKiB !== null && availableKiB > totalKiB)) throw new Error("INVALID_MEMORY");
      return { total: totalKiB, available: availableKiB };
    }),
  };
  const modStatus = {
    version: await field("manifest", "natartos manifest version", value => {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || !("natartos_version" in parsed) || typeof parsed.natartos_version !== "string") throw new Error("INVALID_MANIFEST");
      return text(/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/)(parsed.natartos_version);
    }),
    disabled: await field("disabled", "natartos disabled marker", yesNo),
    loaderActive: await field("loader", "dji_glasses mapped loader", yesNo),
  };
  return {
    schema: "toolya-diagnostics-v1",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    device, resources, modStatus,
    temperatures: { value: null, status: "unavailable", source: null },
    warnings: [...warnings, "temperature:sources-not-validated"],
    privacy: { deviceIdentifiersIncluded: false, rawLogsIncluded: false },
  };
}

export function collectAdbDiagnostics(adb: Adb, options: DiagnosticOptions = {}) {
  return collectDiagnostics((_, command) => readQuery(adb, command, options), options);
}
