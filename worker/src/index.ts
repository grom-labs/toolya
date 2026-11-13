// toolya edge Worker: serves the web app (static assets), accepts one anonymous
// aggregate telemetry beacon (POST /api/stat → Analytics Engine), and exposes the
// public rooted-count badge (GET /api/rooted). No key, no personal data.

export interface Env {
  ASSETS: Fetcher;
  AE: AnalyticsEngineDataset;
  // optional: a CF API token with "Account Analytics: Read" to power /api/rooted.
  // Set with:  wrangler secret put ANALYTICS_TOKEN
  ANALYTICS_TOKEN?: string;
  // "true" = demo mode: the app simulates enable/connect, writes no stats, touches no
  // device. Toggled in wrangler.toml [vars]. Used for a look-only preview.
  DRY_RUN?: string;
  // per-IP rate limiter for the anonymous stat beacon (deters count inflation)
  STAT_RL?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const DRY_FLAG = '<script>window.__TOOLYA_DRY_RUN__=1;</scr' + "ipt>";

// CSP for the HTML pages. Inline styles/scripts are used throughout; WASM needs
// wasm-unsafe-eval. External origins: Google Fonts (style+font), api.github.com
// (release lookups), ko-fi (donation iframe). No external script origins.
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src 'self' https://api.github.com",
  "frame-src https://ko-fi.com",
].join("; ");

// Serve a static asset with security headers; inject the dry-run flag into HTML pages.
async function serveAsset(res: Response, env: Env): Promise<Response> {
  const isHtml = (res.headers.get("content-type") || "").includes("text/html");
  if (!isHtml) {
    const h = new Headers(res.headers);
    h.set("x-content-type-options", "nosniff");
    return new Response(res.body, { status: res.status, headers: h });
  }
  let html = await res.text();
  if (env.DRY_RUN === "true") html = html.replace("</head>", DRY_FLAG + "</head>");
  const h = new Headers(res.headers);
  h.delete("content-length");
  h.delete("content-encoding"); // body is now decoded
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", CSP);
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(html, { status: res.status, headers: h });
}

const ACCOUNT_ID = "f057f2bb210efc14edfc6cfef416a7f9";

// Only these event names are recorded; anything else is ignored.
const STAT_EVENTS = new Set([
  "page_view",
  "disclaimer_ok",
  "enable_start",
  "enable_ok",
  "enable_fail",
  "connect_ok",
  "connect_fail",
  "mod_install",
  "device_report",
]);

const clamp = (v: unknown, n: number): string =>
  typeof v === "string" ? v.slice(0, n) : "";

// Estimated count of successful roots (connect_ok) over the Analytics Engine
// retention window. Needs ANALYTICS_TOKEN; returns null if unavailable.
async function rootedCount(env: Env): Promise<number | null> {
  if (!env.ANALYTICS_TOKEN) return null;
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.ANALYTICS_TOKEN}`,
          "content-type": "text/plain",
        },
        // unique rooters: distinct per-browser ids (blob6) that reached connect_ok
        body: "SELECT count(DISTINCT blob6) AS n FROM toolya WHERE blob1 = 'connect_ok'",
      },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: Array<{ n?: string | number }> };
    const n = j.data?.[0]?.n;
    return n == null ? 0 : Math.round(Number(n));
  } catch {
    return null;
  }
}

const CORS_ORIGINS = new Set(["https://toolya.dev", "http://localhost:5173"]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (!CORS_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function withCors(res: Response, req: Request): Response {
  const ch = corsHeaders(req);
  if (!Object.keys(ch).length) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(ch)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return new Response("ok");

    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    // Anonymous success/failure + platform stat. Fire-and-forget: always 204,
    // never blocks the client, stores nothing identifying (no IP, serial, device id).
    if (url.pathname === "/api/stat" && req.method === "POST") {
      // rate-limit per IP so the anonymous count can't be trivially inflated
      if (env.STAT_RL) {
        const ip = req.headers.get("cf-connecting-ip") || "0";
        const { success } = await env.STAT_RL.limit({ key: ip });
        if (!success) return new Response(null, { status: 204 });
      }
      try {
        const b = (await req.json()) as Record<string, unknown>;
        const ev = clamp(b.ev, 24);
        if (STAT_EVENTS.has(ev) && env.AE) {
          env.AE.writeDataPoint({
            indexes: [ev],
            // blob6 = cid: a random per-browser id (NOT the device serial), for unique-browser funnel counts.
            blobs: [ev, clamp(b.os, 12), clamp(b.browser, 12), clamp(b.stage, 24), clamp(b.reason, 24), clamp(b.cid, 40)],
            doubles: [1],
          });
        }
      } catch {
        /* ignore malformed beacons */
      }
      return withCors(new Response(null, { status: 204 }), req);
    }

    // Public rooted-count badge. Cached 5 min at the edge to spare the SQL API.
    if (url.pathname === "/api/rooted" && req.method === "GET") {
      const cache = caches.default;
      const hit = await cache.match(req);
      if (hit) return withCors(hit, req);
      const n = await rootedCount(env);
      const resp = new Response(JSON.stringify(n == null ? {} : { rooted: n }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
      });
      ctx.waitUntil(cache.put(req, resp.clone()));
      return withCors(resp, req);
    }

    // same-origin proxy for natartos release-asset downloads (GitHub assets don't send
    // CORS headers). Restricted to grom-labs/natartos release URLs.
    if (url.pathname === "/api/dl" && req.method === "GET") {
      const u = url.searchParams.get("u") || "";
      let target: URL;
      try {
        target = new URL(u);
      } catch {
        return new Response("bad url", { status: 400 });
      }
      // tight allowlist: only grom-labs/natartos release downloads on github.com.
      // (the worker follows the redirect to githubusercontent.com server-side.)
      const ok =
        target.protocol === "https:" &&
        target.hostname === "github.com" &&
        target.pathname.startsWith("/grom-labs/natartos/releases/");
      if (!ok) return new Response("forbidden", { status: 403 });
      const up = await fetch(target.toString(), { headers: { "User-Agent": "toolya" }, redirect: "follow" });
      return withCors(new Response(up.body, {
        status: up.status,
        headers: {
          "content-type": up.headers.get("content-type") || "application/octet-stream",
          "x-content-type-options": "nosniff",
          "content-disposition": "attachment",
        },
      }), req);
    }

    // the tool pages (root + natartos view) are the same app.html; the client routes by path
    if (["/app", "/app/", "/natartos", "/natartos/"].includes(url.pathname)) {
      const u = new URL(req.url);
      u.pathname = "/app.html";
      return serveAsset(await env.ASSETS.fetch(new Request(u, req)), env);
    }

    // everything else: landing + static assets (unknown paths fall back to index.html)
    return serveAsset(await env.ASSETS.fetch(req), env);
  },
} satisfies ExportedHandler<Env>;
