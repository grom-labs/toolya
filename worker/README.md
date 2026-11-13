# toolya/worker — edge deploy (Cloudflare)

The Worker serves the web app (static assets) only — **no API, no key**. The DUML
enable plan is computed in the browser by the Rust core compiled to WASM, so there is
no origin server to run.

## Build / check (no account needed)
    npm install
    npm run check      # dry-run: bundles the app, lists bindings

## Deploy (Cloudflare account)
Domain is **toolya.dev** (apex + www), wired in `wrangler.toml` as a custom domain.

    0. Add toolya.dev to Cloudflare: create the zone, point the registrar's
       nameservers to the CF ones. (Required before the custom-domain routes work.)
    1. wrangler login
    2. npm run deploy        # provisions DNS + TLS for toolya.dev automatically

Before a domain is attached you can also deploy to `toolya.workers.dev` for a smoke test.

Telemetry is disabled in the scripts (`WRANGLER_SEND_METRICS=false`).

Since the Worker only serves static assets, you can equally host `web/dist` on
Cloudflare Pages or any static host.
