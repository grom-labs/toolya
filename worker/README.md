# toolya/worker — edge deploy (Cloudflare)

The Worker serves the web app (static assets) and a few small endpoints: anonymous
telemetry (`/api/stat` → Analytics Engine), a public rooted-count badge (`/api/rooted`),
and a CORS download proxy for natartos release assets (`/api/dl`). The DUML enable plan
is computed in the browser by the Rust core compiled to WASM — no origin server needed.

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

The static assets (`web/dist`) can also be hosted on Cloudflare Pages or any
static host, but the API endpoints (`/api/*`) require the Worker.
