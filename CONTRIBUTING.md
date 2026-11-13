# Contributing to toolya

Thanks for helping out. toolya is small and the bar is simple: keep it honest, keep it
working, and respect the scope.

## Project layout

- `core/` — Rust, the DUML protocol core. Compiles to a native lib **and** to WASM.
- `cli/` — Rust CLI (`toolya`), the full toolkit.
- `web/` — the WebUSB browser app (Vite + TypeScript); the thin client most people use.
- `worker/` — the Cloudflare Worker that serves `web/` (static assets) + API endpoints
  (anonymous telemetry, rooted-count badge, natartos download proxy).
- `tools/gen_contract.py` — **codegen**: `core/src/contract.rs` is generated from a
  maintainer-held device-facts file. Treat `contract.rs` as source; don't hand-edit it,
  and don't expect to regenerate it without that file (it's not in this repo).

## Build & test

Everything is driven by two scripts, or run each piece by hand:

```
cargo build --workspace
cargo test  --workspace
# core → WASM (needs wasm-pack + the wasm32-unknown-unknown target):
cd core && wasm-pack build --target web --out-dir ../web/vendor/core-wasm --features wasm
# web:
cd web && npm ci && npm run typecheck && npm run build
```

`web/vendor/core-wasm/` is generated (gitignored) — build the WASM before the web app.

CI runs the same steps (`.github/workflows/ci.yml`). A PR should be green there.

## Pull requests

- Keep the **UI and README honest** — advertise only what actually works. "Works" means
  verified, ideally on hardware; mark anything else as experimental/WIP.
- Small, focused PRs. Explain the *why* in 1–2 lines; the code shows the *what*.
- No new dependency without a reason. Prefer the standard library / existing deps.
- Run the build + tests + web typecheck locally first.

## Scope & safety (not negotiable)

- toolya is for **your own device**, for interoperability and local development.
- **No vendor code redistributed** — no firmware, binaries, or unpacked scripts. Scrub
  serials and any keys from logs, dumps, screenshots, and test data before sharing.
- **No bricking automation** — don't wrap destructive factory/partition operations.
- Not affiliated with the device vendor; product names are trademarks of their owner.

## License

By contributing you agree your work is licensed under **AGPL-3.0** (see `LICENSE`), with
the attribution term in `NOTICE`.
