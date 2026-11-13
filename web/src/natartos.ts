// WebUSB install of the natartos mod framework — mirrors the CLI (toolya natartos
// install). Manifest-driven (docs/natartos-manifest.md), sha256-verified before any
// device write. Release assets are fetched through the same-origin Worker proxy
// (/api/dl) because GitHub asset downloads don't send CORS headers.
//
// Gated: there are no natartos releases yet, so fetchLatestRelease() returns null and
// the Install button stays inert until a release with the anti-brick loader exists.

import type { Adb } from "@yume-chan/adb";
import { run, pushFile } from "./adb";

const REPO = "grom-labs/natartos";
const STOCK = "/vendor/natartos/stock";
const MANIFEST_DEVICE = "/vendor/natartos/manifest.json";

interface Artifact {
  file: string;
  device_path: string;
  mode?: string;
  sha256: string;
}
interface Manifest {
  schema: number;
  natartos_version?: string;
  device?: string;
  init_rc: { device_path: string; content: string };
  loader: Artifact;
  mods?: Artifact[];
  backup?: string[];
  remove?: string[];
}
export interface Release {
  tag_name: string;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

export async function fetchLatestRelease(): Promise<Release | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return null;
    return (await r.json()) as Release;
  } catch {
    return null;
  }
}

// download a release asset via the Worker proxy (GitHub asset CORS)
async function dl(assetUrl: string): Promise<Uint8Array> {
  const r = await fetch(`/api/dl?u=${encodeURIComponent(assetUrl)}`);
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const parentDir = (p: string) => p.replace(/\/[^/]+$/, "") || "/";
const te = (s: string) => new TextEncoder().encode(s);

/** Download + verify + apply a natartos release over adb. Throws on any mismatch. */
export async function installFromRelease(adb: Adb, rel: Release, log: (s: string) => void): Promise<void> {
  const asset = (name: string) => rel.assets.find((a) => a.name === name);

  const mAsset = asset("manifest.json");
  if (!mAsset) throw new Error("release is missing manifest.json");
  log("fetching manifest…");
  const manifest = JSON.parse(new TextDecoder().decode(await dl(mAsset.browser_download_url))) as Manifest;
  if (manifest.schema !== 1) throw new Error(`manifest schema ${manifest.schema} unsupported — update toolya`);

  // 1. download + verify EVERY artifact before touching the device
  const arts = [manifest.loader, ...(manifest.mods ?? [])];
  const files: { art: Artifact; bytes: Uint8Array }[] = [];
  for (const art of arts) {
    const a = asset(art.file);
    if (!a) throw new Error(`release is missing ${art.file}`);
    log(`downloading ${art.file}…`);
    const bytes = await dl(a.browser_download_url);
    const got = await sha256hex(bytes);
    if (!art.sha256 || got.toLowerCase() !== art.sha256.toLowerCase())
      throw new Error(`sha256 mismatch for ${art.file} — refusing to install`);
    files.push({ art, bytes });
  }

  // 2. device check
  if (manifest.device) {
    const model = (await run(adb, "getprop ro.product.device; getprop ro.product.model")).toLowerCase();
    const hit = manifest.device.toLowerCase().split(/\s+/).some((t) => model.includes(t));
    if (!hit) throw new Error(`device mismatch: this release targets ${manifest.device}`);
  }

  // 3. apply
  log("remounting /vendor rw…");
  await run(adb, "mount -o remount,rw /vendor");
  await run(adb, `mkdir -p ${STOCK}`);

  for (const p of manifest.backup ?? []) {
    const base = p.split("/").pop();
    await run(adb, `[ -f ${STOCK}/${base}.orig ] || cp ${p} ${STOCK}/${base}.orig`);
  }
  for (const { art, bytes } of files) {
    log(`pushing ${art.file}…`);
    await run(adb, `mkdir -p ${parentDir(art.device_path)}`);
    await pushFile(adb, art.device_path, bytes);
    await run(adb, `chmod ${art.mode ?? "0644"} ${art.device_path}`);
  }
  for (const p of manifest.remove ?? []) await run(adb, `rm -f ${p}`);

  log("writing vendor init…");
  await pushFile(adb, manifest.init_rc.device_path, te(manifest.init_rc.content));
  await run(adb, `chmod 644 ${manifest.init_rc.device_path}`);
  // record the applied manifest for uninstall
  await pushFile(adb, MANIFEST_DEVICE, te(JSON.stringify(manifest)));
  await run(adb, "rm -f /data/.natartos_bootcount /data/.natartos_status /data/.natartos_disabled");
  await run(adb, "sync");

  log(`natartos ${manifest.natartos_version ?? ""} installed — reboot to activate.`);
}
