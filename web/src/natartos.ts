// WebUSB install of the natartos mod framework — mirrors the CLI (toolya natartos
// install). Manifest-driven (docs/natartos-manifest.md), sha256-verified before any
// device write. Release assets are fetched through the same-origin Worker proxy
// (/api/dl) because GitHub asset downloads don't send CORS headers.
//
// Gated: there are no natartos releases yet, so fetchLatestRelease() returns null and
// the Install button stays inert until a release with the anti-brick loader exists.

import type { Adb } from "@yume-chan/adb";
import { run, pushFile } from "./adb";
import { getContract } from "./wasm";

interface Artifact {
  file: string;
  device_path: string;
  mode?: string;
  sha256: string;
}
// a selectable mod: an artifact plus UI/selection metadata
export interface Mod extends Artifact {
  id: string;
  name?: string;
  description?: string;
  provides?: string;
  default?: boolean;
}
export interface Manifest {
  schema: number;
  natartos_version?: string;
  device?: string;
  init_rc: { device_path: string; content: string };
  loader: Artifact;
  files?: Artifact[];
  mods?: Mod[];
  backup?: string[];
  remove?: string[];
}
export interface Release {
  tag_name: string;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}
// a user-supplied mod (not from a signed release → never telemetried)
export interface CustomMod {
  name: string;
  bytes: Uint8Array;
}

export async function fetchLatestRelease(): Promise<Release | null> {
  try {
    const { natartos: nc } = await getContract();
    const r = await fetch(`https://api.github.com/repos/${nc.repo}/releases/latest`, {
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
// single-quote a value for safe interpolation into a root shell command
const shq = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;
// install only ever writes under /vendor; reject anything else (manifest is untrusted
// until releases are signed — see SECURITY.md).
function vendorPath(p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/vendor/") || p.includes("..") || /[\n\r\0]/.test(p))
    throw new Error(`refusing unsafe device path in manifest: ${String(p)}`);
  return p;
}
function safeMode(m?: string): string {
  const v = m ?? "0644";
  if (!/^[0-7]{3,4}$/.test(v)) throw new Error(`refusing unsafe mode in manifest: ${v}`);
  return v;
}
function customModPath(name: string): string {
  const base = name.split(/[/\\]/).pop() || "";
  if (!/^[A-Za-z0-9._-]+\.so$/.test(base)) throw new Error(`invalid custom mod name: ${name}`);
  return vendorPath(`/vendor/natartos/mods/${base}`);
}

/** Download + parse a release's manifest.json (so the UI can list selectable mods). */
export async function loadManifest(rel: Release): Promise<Manifest> {
  const a = rel.assets.find((x) => x.name === "manifest.json");
  if (!a) throw new Error("release is missing manifest.json");
  const m = JSON.parse(new TextDecoder().decode(await dl(a.browser_download_url))) as Manifest;
  if (m.schema !== 1) throw new Error(`manifest schema ${m.schema} unsupported — update toolya`);
  return m;
}

/** Install the loader + the selected release mods (by id) + any custom .so, over adb.
 *  Everything is sha256-verified (release mods) and path-validated before any write.
 *  Returns the installed **release** mod ids (for anonymous per-mod telemetry). */
export async function installFromRelease(
  adb: Adb,
  rel: Release,
  manifest: Manifest,
  opts: { modIds: string[]; custom?: CustomMod[] },
  log: (s: string) => void,
): Promise<string[]> {
  const { natartos: nc } = await getContract();
  const asset = (name: string) => rel.assets.find((a) => a.name === name);
  const chosen = (manifest.mods ?? []).filter((m) => opts.modIds.includes(m.id));

  // 1. download + sha256-verify the loader + chosen release mods before touching the device
  const dlVerify = async (art: Artifact): Promise<Uint8Array> => {
    const a = asset(art.file);
    if (!a) throw new Error(`release is missing ${art.file}`);
    log(`downloading ${art.file}…`);
    const bytes = await dl(a.browser_download_url);
    const got = await sha256hex(bytes);
    if (!art.sha256 || got.toLowerCase() !== art.sha256.toLowerCase())
      throw new Error(`sha256 mismatch for ${art.file} — refusing to install`);
    return bytes;
  };
  const loaderBytes = await dlVerify(manifest.loader);
  const fileEntries: { art: Artifact; bytes: Uint8Array }[] = [];
  for (const f of manifest.files ?? []) fileEntries.push({ art: f, bytes: await dlVerify(f) });
  const modFiles: { art: Mod; bytes: Uint8Array }[] = [];
  for (const m of chosen) modFiles.push({ art: m, bytes: await dlVerify(m) });

  // 2. device check
  if (manifest.device) {
    const model = (await run(adb, "getprop ro.product.device; getprop ro.product.model")).toLowerCase();
    const hit = manifest.device.toLowerCase().split(/\s+/).some((t) => model.includes(t));
    if (!hit) throw new Error(`device mismatch: this release targets ${manifest.device}`);
  }

  // 3. validate every path/mode (manifest + custom are untrusted; writes stay under /vendor)
  const rcPath = vendorPath(manifest.init_rc.device_path);
  const loaderPlan = {
    file: manifest.loader.file,
    path: vendorPath(manifest.loader.device_path),
    mode: safeMode(manifest.loader.mode),
    bytes: loaderBytes,
  };
  const filesPlan = fileEntries.map(({ art, bytes }) => ({
    file: art.file,
    path: vendorPath(art.device_path),
    mode: safeMode(art.mode),
    bytes,
  }));
  const modPlan = modFiles.map(({ art, bytes }) => ({
    file: art.file,
    path: vendorPath(art.device_path),
    mode: safeMode(art.mode),
    bytes,
  }));
  const customPlan = (opts.custom ?? []).map((c) => ({
    file: c.name,
    path: customModPath(c.name), // sanitized → /vendor/natartos/mods/<name>.so
    mode: "0644",
    bytes: c.bytes,
  }));
  const backups = (manifest.backup ?? []).map(vendorPath);
  const removes = (manifest.remove ?? []).map(vendorPath);

  // 4. apply (all interpolated values validated + single-quoted)
  log("remounting /vendor rw…");
  await run(adb, "mount -o remount,rw /vendor");
  await run(adb, `mkdir -p ${shq(nc.stock_dir)}`);
  for (const p of backups) {
    const base = p.split("/").pop();
    const orig = `${nc.stock_dir}/${base}.orig`;
    await run(adb, `[ -f ${shq(orig)} ] || cp ${shq(p)} ${shq(orig)}`);
  }
  for (const { file, path, mode, bytes } of [loaderPlan, ...filesPlan, ...modPlan, ...customPlan]) {
    log(`pushing ${file}…`);
    await run(adb, `mkdir -p ${shq(parentDir(path))}`);
    await pushFile(adb, path, bytes);
    await run(adb, `chmod ${mode} ${shq(path)}`);
  }
  for (const p of removes) await run(adb, `rm -f ${shq(p)}`);

  log("writing vendor init…");
  await pushFile(adb, rcPath, te(manifest.init_rc.content));
  await run(adb, `chmod 644 ${shq(rcPath)}`);
  // record installed state (version + chosen mod ids + custom names) for status/uninstall
  const installed = {
    natartos_version: manifest.natartos_version,
    mods: chosen.map((m) => m.id),
    custom: customPlan.map((c) => c.path.split("/").pop()),
  };
  await pushFile(adb, nc.manifest_device, te(JSON.stringify(manifest)));
  await pushFile(adb, "/vendor/natartos/installed.json", te(JSON.stringify(installed)));
  await run(adb, `rm -f ${nc.bootcount} ${nc.status} ${nc.disabled}`);
  await run(adb, "sync");

  log(`natartos ${manifest.natartos_version ?? ""} installed (${chosen.length + customPlan.length} mod(s)) — reboot to activate.`);
  return chosen.map((m) => m.id);
}
