# Security

toolya roots **your own** device from the browser. Here's what it does and doesn't do
with your data and your device, and the trust boundaries involved.

## Reporting a vulnerability

Open a **private security advisory** on GitHub (Security → Advisories) for
`grom-labs/toolya`, or email the address in the org profile. Please don't file public
issues for security bugs.

## What runs where

- The **enable/adb/root** logic runs **in your browser** over WebUSB — there is no server
  in the loop. The DUML packet plan is computed locally (Rust→WASM). The site is static
  assets served by a Cloudflare Worker.
- The Worker exposes only: `/healthz`, `/api/stat` (anonymous telemetry, write-only),
  `/api/rooted` (a public count), and `/api/dl` (a download proxy, below). No endpoint
  accepts or returns device data, serials, or credentials.

## Telemetry & privacy

- **Anonymous and aggregate only**: event (enable/connect outcome), coarse OS + browser,
  and a failure stage/reason. Plus a **random per-browser id** (not derived from the
  device, never the serial) so the funnel can be counted by unique browsers.
- **Never collected**: IP (not stored), device serial, device id, or any personal data.
- **Do-Not-Track** is honored — with it set, nothing is sent.
- The public **rooted count** is best-effort and **not trustworthy as a hard number** — the
  telemetry endpoint is unauthenticated (it's per-IP rate-limited, which deters casual
  inflation but can't prevent it). Treat it as a vanity metric.

## Install trust model (natartos)

Installing natartos writes a native loader and mods to `/vendor` on your device. toolya:

- downloads them **only** from the `grom-labs/natartos` GitHub **releases** (via the
  same-origin `/api/dl` proxy, which is allow-listed to that repo's release URLs only), and
- **verifies each artifact's SHA-256** against the release `manifest.json` before writing
  anything to the device, and backs up the files it replaces.

The SHA-256 check guarantees **transport integrity** (you got the bytes the release lists),
**not** that a release is benign. Installing means **trusting whoever controls the
`grom-labs/natartos` releases** — exactly as with any software installer. Release
**signing** (a key pinned in toolya) is planned to raise this bar.

Install is also gated on natartos's own **brick-prevention** (a boot-loop auto-disables
mods) being present and verified on hardware. Until then the Install button is inert.

## Scope / your responsibility

- Use on **hardware you own**. Enabling root is an unauthorized modification of your device
  (see the in-app disclaimer) and you accept the risk.
- toolya ships **no vendor firmware or binaries**, and doesn't automate destructive factory
  operations.
