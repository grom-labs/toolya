// Live screen monitor over ADB.
//
// Modes (auto-selected, best available first):
// 1. mjpeg  — fb_stream binary on device encodes JPEG at up to 60 fps,
//             streamed over ADB subprocess stdout. Needs natartos display hook.
// 2. raw    — pull fb_shared/screencap as raw BGRA (3-5 fps fallback).
//
// fb_stream protocol: [uint32_le jpeg_size][jpeg_bytes] per frame, continuously.

import type { Adb } from "@yume-chan/adb";
import { pullFile, run, pushFile } from "./adb";
import { SCREEN_W, SCREEN_H } from "./image";
import { getContract } from "./wasm";

const FRAME_BYTES = SCREEN_W * SCREEN_H * 4;
const PIXEL_COUNT = SCREEN_W * SCREEN_H;
const FB_STREAM_PATH = "/data/local/tmp/fb_stream";

export type StreamMode = "mjpeg" | "raw";

export interface StreamHandle {
  stop(): void;
  readonly fps: number;
  readonly mode: StreamMode;
  readonly active: boolean;
}

// Binary is fetched from the Worker at build time and cached.
let binaryCache: Uint8Array | null = null;
async function getFbStreamBinary(): Promise<Uint8Array> {
  if (binaryCache) return binaryCache;
  const r = await fetch("/fb_stream");
  if (!r.ok) throw new Error(`fetch fb_stream: ${r.status}`);
  binaryCache = new Uint8Array(await r.arrayBuffer());
  return binaryCache;
}

async function ensureFbStream(adb: Adb): Promise<boolean> {
  // Check if already present and executable
  try {
    const out = await run(adb, `[ -x ${FB_STREAM_PATH} ] && ${FB_STREAM_PATH} --version 2>&1 || echo MISSING`);
    if (!out.includes("MISSING")) return true;
  } catch { /* not present */ }

  // Push the binary
  try {
    const bin = await getFbStreamBinary();
    await pushFile(adb, FB_STREAM_PATH, bin);
    await run(adb, `chmod 755 ${FB_STREAM_PATH}`);
    return true;
  } catch {
    return false;
  }
}

export async function startStream(
  adb: Adb,
  canvas: HTMLCanvasElement,
  onStatus?: (fps: number, mode: StreamMode) => void,
  onError?: (err: unknown) => void,
): Promise<StreamHandle> {
  const c = await getContract();

  // The monitor always captures the real UI via the screencap trigger. fb_shared
  // is the PC-stream INJECT buffer — reading it back shows injected or stale
  // frames, not the live screen, so it is never a capture source. MJPEG needs a
  // real on-device encoder (fb_stream) reading the scanout DMA-bufs; until that
  // binary ships, ensureFbStream fails and we stay on raw.
  let mode: StreamMode = "raw";
  if (await ensureFbStream(adb)) mode = "mjpeg";

  const ctx = canvas.getContext("2d")!;
  let running = true;
  let fps = 0;
  let frames = 0;
  let fpsT0 = performance.now();
  let proc: { kill(): void | PromiseLike<void> } | null = null;
  let reader: { cancel(): Promise<void>; releaseLock(): void } | null = null;

  // Cleanup is best-effort after a disconnect, but its async failures still
  // need a rejection handler because stop() is intentionally synchronous.
  function cleanup(action: () => void | PromiseLike<void>) {
    void (async () => {
      try { await action(); } catch { /* already closing */ }
    })();
  }

  function close() {
    running = false;
    const r = reader;
    reader = null;
    if (r) {
      cleanup(async () => {
        try { await r.cancel(); } finally { r.releaseLock(); }
      });
    }
    const p = proc;
    proc = null;
    if (p) cleanup(() => p.kill());
  }

  function tickFps() {
    if (!running) return;
    frames++;
    const now = performance.now();
    const dt = now - fpsT0;
    if (dt >= 1000) {
      fps = frames * 1000 / dt;
      frames = 0;
      fpsT0 = now;
      onStatus?.(fps, mode);
    }
  }

  if (mode === "mjpeg") {
    // Spawn fb_stream on the device, read JPEG frames from stdout
    (async () => {
      try {
        const p = await adb.subprocess.noneProtocol.spawn(`${FB_STREAM_PATH} 75 60`);
        proc = p;
        // Stop may have run while spawn was pending. The finally block also
        // closes this late process without starting a reader.
        if (!running) return;

        const outputReader = p.output.getReader();
        reader = outputReader;
        let buf = new Uint8Array(0);

        while (running) {
          const { done, value } = await outputReader.read();
          if (!running || done) break;

          // Append chunk to buffer
          const next = new Uint8Array(buf.length + value.length);
          next.set(buf);
          next.set(value, buf.length);
          buf = next;

          // Parse frames: [uint32_le size][jpeg_bytes]
          while (running && buf.length >= 4) {
            const sz = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
            if (sz === 0 || sz > 10_000_000) { running = false; break; }
            if (buf.length < 4 + sz) break; // need more data

            const jpeg = buf.slice(4, 4 + sz);
            buf = buf.slice(4 + sz);

            // Decode JPEG using browser native decoder
            const blob = new Blob([jpeg], { type: "image/jpeg" });
            const bmp = await createImageBitmap(blob);
            try {
              if (!running) return;
              ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            } finally {
              bmp.close();
            }
            tickFps();
          }
        }
      } catch (e) {
        const report = running;
        close();
        if (report) onError?.(e);
      } finally {
        close();
      }
    })();
  } else {
    // Raw BGRA pull fallback
    const offscreen = document.createElement("canvas");
    offscreen.width = SCREEN_W;
    offscreen.height = SCREEN_H;
    const offCtx = offscreen.getContext("2d")!;
    const imgData = offCtx.createImageData(SCREEN_W, SCREEN_H);
    const dst32 = new Uint32Array(imgData.data.buffer);

    function renderRaw(bgra: Uint8Array, offset: number) {
      if (!running) return;
      const src = new Uint32Array(bgra.buffer, bgra.byteOffset + offset, PIXEL_COUNT);
      for (let i = 0; i < PIXEL_COUNT; i++) {
        const px = src[i];
        dst32[i] = 0xFF000000 | ((px & 0xFF) << 16) | (px & 0xFF00) | ((px >> 16) & 0xFF);
      }
      offCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
      tickFps();
    }

    (async () => {
      try {
        while (running) {
          await run(adb, c.screen.grab_trigger);
          if (!running) break;
          await sleep(80);
          if (!running) break;
          const raw = await pullFile(adb, c.files.screencap);
          if (!running) break;
          if (raw.length !== FRAME_BYTES) { await sleep(200); continue; }
          renderRaw(raw, 0);
        }
      } catch (e) {
        const report = running;
        close();
        if (report) onError?.(e);
      } finally {
        close();
      }
    })();
  }

  return {
    stop: close,
    get fps() { return fps; },
    get mode() { return mode; },
    get active() { return running; },
  };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
