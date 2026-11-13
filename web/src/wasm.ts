// Compute the adb-enable plan locally in the browser via the Rust core compiled to
// WebAssembly. No server, no key. Loaded lazily (dynamic import).
import init, { enable_plan } from "../vendor/core-wasm/toolya_core.js";
import wasmUrl from "../vendor/core-wasm/toolya_core_bg.wasm?url";

let ready: Promise<unknown> | null = null;

export async function enablePlan(): Promise<string> {
  if (!ready) ready = init({ module_or_path: wasmUrl });
  await ready;
  return enable_plan();
}
