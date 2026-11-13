// Raw-WebUSB adb-enable for DJI Goggles 3. This is NOT a single packet: the
// device needs a handshake (confirm it's awake, read until `</dji>`), then a
// cmd_id scan — the enable cmd_id shifts between boots, so we send candidates
// until the device disconnects (= USB reconfiguring to ADB).
//
// getEnablePlan() computes the packet plan in the browser via the Rust core
// (WASM) — no server, no key. The client only sends/reads/detects.

export const DUML_VID = 0x2ca3;

export interface DeviceInfo {
  vendorId: number;
  productId: number;
  productName: string;
}

// Known DJI Goggles 3 (E3T zv902) USB product IDs in DUML mode.
// If the device's PID isn't in this set, it's untested.
const KNOWN_G3_PIDS = new Set([0x001e]);
const G3_NAME_PATTERN = /goggles\s*3|zv902|e3t/i;

export function isKnownDevice(d: DeviceInfo): boolean {
  return KNOWN_G3_PIDS.has(d.productId) || G3_NAME_PATTERN.test(d.productName);
}

interface EnablePlan {
  handshake: Uint8Array<ArrayBuffer>[];
  init_count: number;
  candidates: Uint8Array<ArrayBuffer>[];
  expect: string;
  iface: number;
  ep_out: number;
  ep_in: number;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function getEnablePlan(): Promise<EnablePlan> {
  // The plan is computed locally in the browser via the Rust core (WASM).
  // Dynamic import keeps WASM lazy (loaded on first enable).
  const { enablePlan } = await import("./wasm");
  const json = await enablePlan();
  const p = JSON.parse(json) as {
    handshake: string[];
    init_count: number;
    candidates: string[];
    expect: string;
    iface: number;
    ep_out: number;
    ep_in: number;
  };
  return {
    handshake: p.handshake.map(hexToBytes),
    init_count: p.init_count,
    candidates: p.candidates.map(hexToBytes),
    expect: p.expect,
    iface: p.iface,
    ep_out: p.ep_out,
    ep_in: p.ep_in,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Prompt for the goggles (DUML mode) and run the full enable sequence.
// Returns info about the USB device so the caller can check if it's a known model.
export async function enableAdb(log: (s: string) => void): Promise<DeviceInfo> {
  if (!navigator.usb) throw new Error("WebUSB not available in this browser");
  const plan = await getEnablePlan();

  const device = await navigator.usb.requestDevice({ filters: [{ vendorId: DUML_VID }] });
  const info: DeviceInfo = {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName ?? "",
  };
  log(`opening ${device.productName ?? "goggles"}…`);
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(plan.iface);

  const dec = new TextDecoder();
  let blob = "";
  let gotExpect = false;

  // concurrent reader: accumulate IN data, watch for `</dji>`
  let reading = true;
  const reader = (async () => {
    while (reading) {
      try {
        const r = await device.transferIn(plan.ep_in, 1024);
        if (r.data && r.data.byteLength) {
          blob += dec.decode(new Uint8Array(r.data.buffer), { stream: true });
          if (blob.includes(plan.expect)) {
            gotExpect = true;
            reading = false;
          }
        }
      } catch {
        break;
      }
    }
  })();

  log("handshake…");
  // init packets, then probe packets until `</dji>`
  for (let i = 0; i < plan.handshake.length; i++) {
    if (gotExpect) break;
    try {
      await device.transferOut(plan.ep_out, plan.handshake[i]);
    } catch {
      break;
    }
    await sleep(i < plan.init_count ? 50 : 60);
  }
  // give the reader a moment to catch the tail
  for (let i = 0; i < 20 && !gotExpect; i++) await sleep(50);
  reading = false;
  void reader;
  if (!gotExpect) log("handshake: no </dji> (goggles may be asleep) — trying enable anyway…");
  else log("handshake ok");

  // cmd_id scan: send candidates until the device disconnects (= enabling)
  await sleep(200);
  let disconnected = false;
  const onDisc = (e: USBConnectionEvent) => {
    if (e.device === device) disconnected = true;
  };
  navigator.usb.addEventListener("disconnect", onDisc);
  try {
    log("enabling adb (scanning)…");
    for (const cand of plan.candidates) {
      if (disconnected) break;
      try {
        await device.transferOut(plan.ep_out, cand);
      } catch {
        disconnected = true; // write failed = device gone = success
        break;
      }
      await sleep(200);
    }
  } finally {
    navigator.usb.removeEventListener("disconnect", onDisc);
  }

  try {
    await device.close();
  } catch {
    /* device re-enumerates after enable; close may throw — ignore */
  }

  if (disconnected) {
    log("adb enabling — goggles re-enumerate in ~5s. Then click Connect.");
  } else {
    throw new Error("no cmd_id triggered a re-enumerate — keep the goggles awake and try again.");
  }
  return info;
}
