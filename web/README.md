# toolya/web

Browser app (WebUSB) for DJI Goggles 3: enable adb, root terminal, usage counters.
Runs in the **user's** Chrome/Edge against goggles plugged into their machine — the
NAS only builds it. WebUSB needs https or localhost; Windows needs WinUSB (Zadig).

## Flow
1. **Enable ADB** — raw WebUSB runs the DUML handshake + cmd_id scan (`src/goggles.ts`).
   The enable plan is computed in-browser by the Rust core compiled to WASM
   (`src/wasm.ts`) — no server, no key.
2. **Connect** — ya-webadb authenticates and opens a root shell (adbd runs as uid 0);
   terminal is a line-editor REPL on xterm.js (`src/adb.ts`, `src/main.ts`).
3. **Usage counters** — power-ons / motor starts from `/data/glasses_statistics.json`
   (`glasses_boot_cnt`, `motor_start_cnt`). Read over adb after connect.

## Build / run (in the toolya-build container)
    docker exec -w /work/web toolya-build npm run build       # -> dist/
    docker exec -w /work/web toolya-build npm run typecheck
Dev server for the Mac: `npm run dev` (serve on localhost so WebUSB is allowed).
