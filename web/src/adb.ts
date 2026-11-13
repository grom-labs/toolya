// ADB-over-WebUSB via ya-webadb: connect (post-enable), open a root PTY, and
// read usage counters. adbd on the goggles runs as uid 0, so the shell is root.
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { ReadableStream } from "@yume-chan/stream-extra";

// Stock desk background on the goggles.
export const BG_PATH = "/data/screendesk_1920.bmp";

// Pull a file from the device into memory (e.g. a raw LiveView BGRA frame).
export async function pullFile(adb: Adb, path: string): Promise<Uint8Array> {
  const sync = await adb.sync();
  try {
    const reader = sync.read(path).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  } finally {
    await sync.dispose();
  }
}

// Push raw bytes to a file on the device (root — adbd runs as uid 0).
export async function pushFile(adb: Adb, path: string, bytes: Uint8Array): Promise<void> {
  const sync = await adb.sync();
  try {
    await sync.write({
      filename: path,
      file: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      permission: 0o644,
    });
  } finally {
    await sync.dispose();
  }
}

export async function connectAdb(): Promise<Adb> {
  const mgr = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!mgr) throw new Error("WebUSB not available in this browser");
  const device = await mgr.requestDevice();
  if (!device) throw new Error("no device selected");
  const connection = await device.connect();
  const credentialStore = new AdbWebCredentialStore("toolya");
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore,
  });
  return new Adb(transport);
}

export interface Pty {
  output: ReadableStream<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;
}

// Open an interactive root PTY (shell v2). This may succeed where the container's
// `adb shell` failed for lack of a PTY.
export async function openPty(adb: Adb): Promise<Pty> {
  const sp = adb.subprocess.shellProtocol;
  if (!sp) throw new Error("device has no shell-protocol (v2) support");
  const pty = await sp.pty({ terminalType: "xterm-256color" });
  const writer = pty.input.getWriter();
  return {
    output: pty.output,
    write: (data) => writer.write(data),
    resize: (rows, cols) => pty.resize(rows, cols),
  };
}

// Run a one-shot command and return its stdout as text.
export async function run(adb: Adb, command: string): Promise<string> {
  const out = await adb.subprocess.noneProtocol.spawnWaitText(command);
  return out;
}

// USB mode switch. rndis keeps acm,adb so access isn't lost. Switching
// re-enumerates USB → the adb connection drops; we fire and don't await a reply.
export const USB_CFG = {
  adb: "acm,adb",
  rndis: "rndis,mass_storage,bulk,acm,adb",
} as const; // uvc dropped: ZV902 doesn't support UVC (#128)

// SELinux session toggle (devmem). `setenforce 0` is neverallow-blocked on the G3,
// so we poke the selinux_state enforce byte. Session-only (resets on reboot).
// Addresses mirror g2-bridge-g3/research/toolya-contract.toml [selinux].state_addrs —
// keep in sync with the contract (the CLI reads them from toolya_core::contract::selinux).
const SELINUX_ADDRS = ["0x17b6648", "0x17e6888"];
const SELINUX_ENFORCE_OFFSET = 1;

export async function getSelinux(adb: Adb): Promise<string> {
  return (await run(adb, "getenforce")).trim();
}

/** mode: "permissive" → 0x00, "enforcing" → 0x01. Returns the resulting state. */
export async function setSelinux(adb: Adb, mode: "permissive" | "enforcing"): Promise<string> {
  const byte = mode === "permissive" ? "0x00" : "0x01";
  const addrs = SELINUX_ADDRS.join(" ");
  const sh =
    `for A in ${addrs}; do V=$(busybox devmem $A 32 2>/dev/null) || continue; ` +
    `case "$V" in 0x01000100|0x01000000) busybox devmem $(printf 0x%X $((A+${SELINUX_ENFORCE_OFFSET}))) 8 ${byte}; break;; esac; done; getenforce`;
  return (await run(adb, sh)).trim();
}

// natartos (persistent mod framework) — read-only status + the low-risk kill-switch.
// Install/uninstall stay in the CLI for now (persistent /vendor writes; brick-risk).
export interface NatartosStatus {
  installed: boolean;
  version: string;
  bootcount: string;
  disabled: boolean;
}
export async function natartosStatus(adb: Adb): Promise<NatartosStatus> {
  const version = (
    await run(
      adb,
      "grep -o '\"natartos_version\"[^,]*' /vendor/natartos/manifest.json 2>/dev/null | cut -d'\"' -f4",
    )
  ).trim();
  const bootcount = (
    await run(
      adb,
      "if [ -f /data/.natartos_bootcount ]; then od -A n -t u4 -N 4 /data/.natartos_bootcount | tr -d ' '; else echo 0; fi",
    )
  ).trim();
  const disabled = (await run(adb, "[ -f /data/.natartos_disabled ] && echo 1 || echo 0")).trim() === "1";
  return { installed: version !== "", version, bootcount, disabled };
}
/** Kill-switch: on = disable mods next boot; off = re-enable + reset bootcount. */
export async function natartosSafe(adb: Adb, on: boolean): Promise<void> {
  if (on) await run(adb, "touch /data/.natartos_disabled");
  else await run(adb, "rm -f /data/.natartos_disabled; printf '\\x00\\x00\\x00\\x00' > /data/.natartos_bootcount");
}

export async function setUsbMode(adb: Adb, mode: keyof typeof USB_CFG): Promise<void> {
  const cfg = USB_CFG[mode];
  await run(adb, `setprop sys.usb.config none; sleep 2; setprop sys.usb.config ${cfg}`).catch(() => {
    /* USB re-enumerates mid-command; a dropped reply is expected */
  });
}

export interface ShellResult {
  output: string;
  cwd: string;
}

// The G3 interactive shell is broken (echoes input, emits sec_debug, returns no
// command output). So the web "terminal" is a one-shot REPL over working command
// mode, with cwd tracked client-side so `cd` persists between commands.
export async function runInDir(adb: Adb, line: string, cwd: string): Promise<ShellResult> {
  const esc = cwd.replace(/'/g, "'\\''");
  const wrapped = `cd '${esc}' 2>/dev/null; ${line}\n__t=$?; echo "__PWD:$(pwd)"`;
  const raw = await run(adb, wrapped);
  let newCwd = cwd;
  const out: string[] = [];
  for (const l of raw.split("\n")) {
    const m = l.match(/^__PWD:(.*)$/);
    if (m) newCwd = m[1] || cwd;
    else out.push(l);
  }
  return { output: out.join("\n"), cwd: newCwd };
}

// Usage counters (goggle power-ons, motor starts) live in a config/db under /data.
// TODO(hw): locate the exact file + keys on the device, then parse here.
export interface UsageCounters {
  powerOns: number | null;
  motorStarts: number | null;
  raw?: string;
}

// Counters live in /data/glasses_statistics.json:
//   { "glasses_boot_cnt": N, "motor_start_cnt": N }
export async function readUsage(adb: Adb): Promise<UsageCounters> {
  const raw = await run(adb, "cat /data/glasses_statistics.json");
  try {
    const j = JSON.parse(raw);
    return {
      powerOns: typeof j.glasses_boot_cnt === "number" ? j.glasses_boot_cnt : null,
      motorStarts: typeof j.motor_start_cnt === "number" ? j.motor_start_cnt : null,
      raw,
    };
  } catch {
    return { powerOns: null, motorStarts: null, raw };
  }
}
