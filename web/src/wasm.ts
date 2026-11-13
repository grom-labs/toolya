// Compute the adb-enable plan locally in the browser via the Rust core compiled to
// WebAssembly. No server, no key. Loaded lazily (dynamic import).
import init, { enable_plan, device_contract } from "../vendor/core-wasm/toolya_core.js";
import wasmUrl from "../vendor/core-wasm/toolya_core_bg.wasm?url";

let ready: Promise<unknown> | null = null;

async function ensureReady() {
  if (!ready) ready = init({ module_or_path: wasmUrl });
  await ready;
}

export async function enablePlan(): Promise<string> {
  await ensureReady();
  return enable_plan();
}

export interface DeviceContract {
  usb: { adb: string; rndis: string };
  selinux: { addrs: string[]; enforce_offset: number };
  files: { background: string; usage: string; screencap: string; fb_shared: string };
  screen: { width: number; height: number; grab_trigger: string; stream_port: number };
  natartos: {
    schema: number; repo: string; stock_dir: string; manifest_device: string;
    bootcount: string; status: string; disabled: string; log: string;
  };
}

let _contract: DeviceContract | null = null;

export async function getContract(): Promise<DeviceContract> {
  await ensureReady();
  if (!_contract) _contract = JSON.parse(device_contract()) as DeviceContract;
  return _contract;
}
