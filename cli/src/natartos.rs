//! natartos — the on-device firmware mod framework for the Goggles 3 (modloader,
//! mods/services, with brick-prevention as its first feature). This module is toolya's
//! installer for it; natartos itself lives in its own repo (grom-labs/natartos).
//!
//! toolya is a generic installer: it never hardcodes natartos's on-device layout.
//! Every natartos release ships a `manifest.json` (schema in docs/natartos-manifest.md)
//! describing what to place where, with a sha256 per artifact. This module fetches the
//! manifest + artifacts (from a GitHub release, or a --local dir), verifies hashes, and
//! applies it over adb.
//!
//! Subcommands:
//!   versions                 list natartos releases
//!   install [--version <t>] [--local <dir>] [--yes]
//!   uninstall [--yes]        restore stock from on-device backups
//!   status                   bootcount / kill-switch / log
//!   safe [on|off]            kill-switch toggle

use adb_client::usb::ADBUSBDevice;
use adb_client::ADBDeviceExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::exit;

const GITHUB_REPO: &str = "grom-labs/natartos";
const SUPPORTED_SCHEMA: u32 = 1;

// toolya install conventions (not in the manifest): where backups and anti-brick
// runtime state live. The loader/mod/.rc paths all come from the manifest.
const STOCK_DIR: &str = "/vendor/natartos/stock";
const MANIFEST_DEVICE_PATH: &str = "/vendor/natartos/manifest.json"; // applied manifest, for uninstall
const DEFAULT_LOADER_PATH: &str = "/vendor/lib64/natartos_loader.so"; // uninstall fallback
const BOOTCOUNT_PATH: &str = "/data/.natartos_bootcount";
const STATUS_PATH: &str = "/data/.natartos_status";
const DISABLED_PATH: &str = "/data/.natartos_disabled";
const LOG_PATH: &str = "/data/local/tmp/natartos.log";

// --- manifest (contract: docs/natartos-manifest.md) ---

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    #[serde(default)]
    natartos_version: String,
    #[serde(default)]
    device: String,
    #[serde(default)]
    min_toolya: String,
    init_rc: InitRc,
    loader: Artifact,
    #[serde(default)]
    mods: Vec<Artifact>,
    #[serde(default)]
    backup: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Deserialize)]
struct InitRc {
    device_path: String,
    content: String,
}

#[derive(Deserialize, Clone)]
struct Artifact {
    file: String,
    device_path: String,
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default)]
    sha256: String,
}

fn default_mode() -> String {
    "0644".into()
}

/// A resolved manifest plus the local directory that holds its artifact files.
struct Resolved {
    manifest: Manifest,
    dir: PathBuf,
    /// true when fetched from a release (hashes required); false for --local dev builds.
    from_release: bool,
}

// --- GitHub Releases API ---

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn api_get(url: &str) -> Result<String, String> {
    ureq::get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "toolya")
        .call()
        .map_err(|e| format!("GitHub API: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("read response: {e}"))
}

/// `None` → latest non-prerelease; `Some(tag)` → that tag.
fn fetch_release(tag: Option<&str>) -> Result<Release, String> {
    let url = match tag {
        Some(t) => format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{t}"),
        None => format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest"),
    };
    let body = api_get(&url)?;
    serde_json::from_str(&body).map_err(|e| format!("parse release: {e}"))
}

fn asset_url<'a>(release: &'a Release, name: &str) -> Result<&'a str, String> {
    release
        .assets
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.browser_download_url.as_str())
        .ok_or_else(|| format!("release is missing asset `{name}`"))
}

fn download_to(url: &str, dest: &Path) -> Result<(), String> {
    let mut reader = ureq::get(url)
        .header("User-Agent", "toolya")
        .call()
        .map_err(|e| format!("download {url}: {e}"))?
        .into_body()
        .into_reader();
    let mut file = File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    io::copy(&mut reader, &mut file).map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(())
}

// --- hashing ---

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Verify a local artifact file against the manifest's sha256.
/// `from_release` builds require a hash; --local dev builds may omit it (warn only).
fn verify(dir: &Path, art: &Artifact, from_release: bool) -> Result<PathBuf, String> {
    let path = dir.join(&art.file);
    if !path.exists() {
        return Err(format!("artifact `{}` not found in {}", art.file, dir.display()));
    }
    if art.sha256.is_empty() {
        if from_release {
            return Err(format!("release manifest has no sha256 for `{}` — refusing", art.file));
        }
        eprintln!("  ⚠ no sha256 for `{}` (local build) — skipping integrity check", art.file);
        return Ok(path);
    }
    let got = sha256_file(&path)?;
    if got.eq_ignore_ascii_case(&art.sha256) {
        Ok(path)
    } else {
        Err(format!(
            "sha256 mismatch for `{}`\n  manifest: {}\n  actual:   {}",
            art.file, art.sha256, got
        ))
    }
}

// --- manifest resolution (download or --local) ---

fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let m: Manifest = serde_json::from_str(&text).map_err(|e| format!("parse manifest: {e}"))?;
    if m.schema != SUPPORTED_SCHEMA {
        return Err(format!(
            "manifest schema {} unsupported (toolya understands {SUPPORTED_SCHEMA}) — update toolya",
            m.schema
        ));
    }
    Ok(m)
}

/// Local dir must contain manifest.json; artifact `file`s may sit in the dir itself
/// or in `src/` / `mods/` subdirs (the natartos build layout). We normalize all
/// artifact files into one flat dir so `verify` can find them by basename.
fn resolve_local(dir: &Path) -> Result<Resolved, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    let manifest = read_manifest(&dir.join("manifest.json"))?;

    let flat = std::env::temp_dir().join("toolya-natartos-local");
    let _ = fs::remove_dir_all(&flat);
    fs::create_dir_all(&flat).map_err(|e| format!("mkdir tmp: {e}"))?;

    let find = |name: &str| -> Option<PathBuf> {
        for cand in [dir.join(name), dir.join("src").join(name), dir.join("mods").join(name)] {
            if cand.exists() {
                return Some(cand);
            }
        }
        None
    };
    let place = |art: &Artifact| -> Result<(), String> {
        let src = find(&art.file)
            .ok_or_else(|| format!("artifact `{}` not found under {}", art.file, dir.display()))?;
        fs::copy(&src, flat.join(&art.file)).map_err(|e| format!("copy {}: {e}", art.file))?;
        Ok(())
    };
    place(&manifest.loader)?;
    for m in &manifest.mods {
        place(m)?;
    }
    Ok(Resolved { manifest, dir: flat, from_release: false })
}

fn resolve_release(tag: Option<&str>) -> Result<Resolved, String> {
    println!("Fetching natartos release ({})...", tag.unwrap_or("latest"));
    let release = fetch_release(tag)?;
    println!("  version: {}", release.tag_name);

    let tmp = std::env::temp_dir().join("toolya-natartos");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| format!("mkdir tmp: {e}"))?;

    // manifest first
    let manifest_url = asset_url(&release, "manifest.json")?;
    let manifest_path = tmp.join("manifest.json");
    download_to(manifest_url, &manifest_path)?;
    let manifest = read_manifest(&manifest_path)?;

    // then each file it names
    let mut need: Vec<&Artifact> = vec![&manifest.loader];
    need.extend(manifest.mods.iter());
    for art in need {
        println!("  downloading {}...", art.file);
        let url = asset_url(&release, &art.file)?;
        download_to(url, &tmp.join(&art.file))?;
    }
    Ok(Resolved { manifest, dir: tmp, from_release: true })
}

// --- version compare (for min_toolya) ---

/// true if `a` < `b` by dotted numeric components (leading 'v' ignored).
/// Unparseable → false (never blocks).
fn version_lt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split(['.', '-', '+'])
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

// --- ADB helpers ---

fn device() -> Result<ADBUSBDevice, String> {
    ADBUSBDevice::autodetect().map_err(|e| format!("USB device not found: {e}"))
}

fn shell(dev: &mut ADBUSBDevice, cmd: &str) -> Result<String, String> {
    let mut stdout = Vec::new();
    let none: Option<&mut dyn std::io::Write> = None;
    dev.shell_command(&cmd, Some(&mut stdout as &mut dyn std::io::Write), none)
        .map_err(|e| format!("shell: {e}"))?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

fn push_file(dev: &mut ADBUSBDevice, local: &Path, remote: &str) -> Result<(), String> {
    let mut f = File::open(local).map_err(|e| format!("open {}: {e}", local.display()))?;
    dev.push(&mut f, &remote).map_err(|e| format!("push → {remote}: {e}"))?;
    Ok(())
}

fn push_bytes(dev: &mut ADBUSBDevice, data: &[u8], remote: &str) -> Result<(), String> {
    let mut cursor = std::io::Cursor::new(data);
    dev.push(&mut cursor, &remote).map_err(|e| format!("push → {remote}: {e}"))?;
    Ok(())
}

// --- commands ---

pub fn run(args: &[String]) {
    let sub = args.first().map(String::as_str).unwrap_or("");
    match sub {
        "versions" => cmd_versions(),
        "install" => {
            let confirmed = args.iter().any(|a| a == "--yes");
            let local = flag_value(args, "--local").map(PathBuf::from);
            let version = flag_value(args, "--version");
            cmd_install(confirmed, local.as_deref(), version.as_deref());
        }
        "uninstall" => cmd_uninstall(args.iter().any(|a| a == "--yes")),
        "status" => cmd_status(),
        "safe" => cmd_safe(args.get(1).map(String::as_str)),
        _ => {
            eprintln!("usage: toolya natartos <versions|install|uninstall|status|safe>");
            eprintln!("  versions                        list natartos releases");
            eprintln!("  install [--version <tag>] [--local <dir>] [--yes]");
            eprintln!("                                  fetch manifest+artifacts, verify, push");
            eprintln!("  uninstall [--yes]               restore stock from device backups");
            eprintln!("  status                          read status from device");
            eprintln!("  safe [on|off]                   toggle kill-switch");
            exit(1);
        }
    }
}

/// Value following `--flag` in args, if present.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

fn cmd_versions() {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases");
    let body = match api_get(&url) {
        Ok(b) => b,
        Err(e) if e.contains("404") => {
            println!("no natartos releases yet ({GITHUB_REPO} not published, or none cut).");
            println!("Build locally and install with:  toolya natartos install --local <dir>");
            return;
        }
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    };
    let releases: Vec<Release> = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("parse releases: {e}");
            exit(1);
        }
    };
    if releases.is_empty() {
        println!("no natartos releases yet (build locally and use `install --local <dir>`)");
        return;
    }
    println!("natartos releases ({GITHUB_REPO}):");
    for r in releases {
        let tag = if r.prerelease { format!("{} (prerelease)", r.tag_name) } else { r.tag_name };
        let date = r.published_at.split('T').next().unwrap_or("");
        println!("  {tag:<24} {date}");
    }
    println!("\ninstall latest:        toolya natartos install");
    println!("install a tag:         toolya natartos install --version <tag>");
}

fn cmd_install(confirmed: bool, local_dir: Option<&Path>, version: Option<&str>) {
    // 1. resolve the manifest + artifact files (download or local)
    let resolved = match local_dir {
        Some(dir) => {
            println!("Using local build: {}", dir.display());
            resolve_local(dir)
        }
        None => resolve_release(version),
    };
    let resolved = match resolved {
        Ok(r) => r,
        Err(e) => {
            if local_dir.is_none() && e.contains("404") {
                eprintln!("No such natartos release ({GITHUB_REPO} not published, or tag not found).");
                eprintln!("Use --local <dir> to install from a local build.");
            } else {
                eprintln!("Could not prepare natartos: {e}");
                if local_dir.is_none() {
                    eprintln!("Use --local <dir> to install from a local build.");
                }
            }
            exit(1);
        }
    };
    let m = &resolved.manifest;

    // 2. verify every artifact's sha256 BEFORE touching the device
    println!("Verifying artifacts...");
    let loader_local = match verify(&resolved.dir, &m.loader, resolved.from_release) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FATAL: {e}");
            exit(1);
        }
    };
    let mut mod_locals = Vec::new();
    for art in &m.mods {
        match verify(&resolved.dir, art, resolved.from_release) {
            Ok(p) => mod_locals.push((art.clone(), p)),
            Err(e) => {
                eprintln!("FATAL: {e}");
                exit(1);
            }
        }
    }
    let min_toolya_ok = m.min_toolya.is_empty()
        || !version_lt(env!("CARGO_PKG_VERSION"), &m.min_toolya);
    if !min_toolya_ok {
        eprintln!(
            "This natartos ({}) needs toolya >= {}; you have {}. Update toolya.",
            m.natartos_version,
            m.min_toolya,
            env!("CARGO_PKG_VERSION")
        );
        exit(1);
    }

    // 3. confirmation
    if !confirmed {
        eprintln!("⚠ natartos install writes to /vendor on your goggles.");
        eprintln!("  version: {}", m.natartos_version);
        eprintln!("  device:  {}", m.device);
        eprintln!("  loader:  {} → {}", m.loader.file, m.loader.device_path);
        for a in &m.mods {
            eprintln!("  mod:     {} → {}", a.file, a.device_path);
        }
        eprintln!("\nRe-run with --yes to proceed:  toolya natartos install --yes");
        exit(1);
    }

    // 4. connect + device check
    println!("Connecting to goggles...");
    let mut dev = match device() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    };
    if !m.device.is_empty() {
        let model = shell(&mut dev, "getprop ro.product.device; getprop ro.product.model")
            .unwrap_or_default()
            .to_lowercase();
        let want = m.device.to_lowercase();
        let hit = want.split_whitespace().any(|tok| model.contains(tok));
        if !hit {
            eprintln!(
                "Device mismatch: manifest targets `{}`, goggles report `{}`. Aborting.",
                m.device,
                model.trim()
            );
            exit(1);
        }
    }

    // 5. apply
    println!("Remounting /vendor rw...");
    let _ = shell(&mut dev, "mount -o remount,rw /vendor");
    let _ = shell(&mut dev, &format!("mkdir -p {STOCK_DIR}"));

    println!("Backing up originals...");
    for path in &m.backup {
        let base = path.rsplit('/').next().unwrap_or(path);
        let _ = shell(
            &mut dev,
            &format!("[ -f {STOCK_DIR}/{base}.orig ] || cp {path} {STOCK_DIR}/{base}.orig"),
        );
    }

    println!("Pushing loader...");
    let _ = shell(&mut dev, &format!("mkdir -p {}", parent_dir(&m.loader.device_path)));
    if let Err(e) = push_file(&mut dev, &loader_local, &m.loader.device_path) {
        eprintln!("FATAL: {e}");
        exit(1);
    }
    let _ = shell(&mut dev, &format!("chmod {} {}", m.loader.mode, m.loader.device_path));

    for (art, local) in &mod_locals {
        println!("Pushing mod {}...", art.file);
        let _ = shell(&mut dev, &format!("mkdir -p {}", parent_dir(&art.device_path)));
        if let Err(e) = push_file(&mut dev, local, &art.device_path) {
            eprintln!("FATAL: {e}");
            exit(1);
        }
        let _ = shell(&mut dev, &format!("chmod {} {}", art.mode, art.device_path));
    }

    for path in &m.remove {
        let _ = shell(&mut dev, &format!("rm -f {path}"));
    }

    println!("Writing vendor init...");
    if let Err(e) = push_bytes(&mut dev, m.init_rc.content.as_bytes(), &m.init_rc.device_path) {
        eprintln!("FATAL: {e}");
        exit(1);
    }
    let _ = shell(&mut dev, &format!("chmod 644 {}", m.init_rc.device_path));

    // record the applied manifest on-device so uninstall knows exact paths
    if let Ok(text) = fs::read_to_string(resolved.dir.join("manifest.json")) {
        let _ = push_bytes(&mut dev, text.as_bytes(), MANIFEST_DEVICE_PATH);
    }

    // clear stale anti-brick state
    let _ = shell(&mut dev, &format!("rm -f {BOOTCOUNT_PATH} {STATUS_PATH} {DISABLED_PATH}"));
    let _ = shell(&mut dev, "sync");

    println!("\n=== natartos {} installed ===", m.natartos_version);
    println!("Reboot to activate, then:  toolya natartos status");
}

fn parent_dir(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() => dir.to_string(),
        _ => "/".to_string(),
    }
}

fn cmd_uninstall(confirmed: bool) {
    if !confirmed {
        eprintln!("⚠ natartos uninstall restores stock vendor init on your goggles.");
        eprintln!("  Removes: loader, mods, state files");
        eprintln!("  Restores: backed-up originals from {STOCK_DIR}");
        eprintln!("\nRe-run with --yes to proceed:  toolya natartos uninstall --yes");
        exit(1);
    }

    println!("Connecting to goggles...");
    let mut dev = match device() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    };

    let _ = shell(&mut dev, "mount -o remount,rw /vendor");

    // read the applied manifest to restore exact files; fall back to convention.
    let applied = shell(&mut dev, &format!("cat {MANIFEST_DEVICE_PATH} 2>/dev/null"))
        .ok()
        .and_then(|t| serde_json::from_str::<Manifest>(&t).ok());

    println!("Restoring originals...");
    let backups: Vec<String> = applied
        .as_ref()
        .map(|m| {
            let mut v = m.backup.clone();
            v.push(m.init_rc.device_path.clone());
            v
        })
        .unwrap_or_else(|| {
            vec![
                "/vendor/etc/init/dji_glasses_custom.rc".into(),
                "/vendor/etc/selinux/precompiled_sepolicy".into(),
            ]
        });
    for path in &backups {
        let base = path.rsplit('/').next().unwrap_or(path);
        let has = shell(&mut dev, &format!("[ -f {STOCK_DIR}/{base}.orig ] && echo yes || echo no"))
            .unwrap_or_default();
        if has.trim() == "yes" {
            let _ = shell(&mut dev, &format!("cp {STOCK_DIR}/{base}.orig {path}"));
            println!("  restored {base}");
        }
    }

    println!("Removing natartos...");
    let loader_path = applied
        .as_ref()
        .map(|m| m.loader.device_path.clone())
        .unwrap_or_else(|| DEFAULT_LOADER_PATH.to_string());
    let _ = shell(&mut dev, &format!("rm -f {loader_path}"));
    if let Some(m) = &applied {
        for a in &m.mods {
            let _ = shell(&mut dev, &format!("rm -f {}", a.device_path));
        }
    }
    let _ = shell(&mut dev, "rm -rf /vendor/natartos");
    let _ = shell(&mut dev, "rm -f /vendor/etc/init/persist_adb.rc");
    let _ = shell(&mut dev, &format!("rm -f {BOOTCOUNT_PATH} {STATUS_PATH} {DISABLED_PATH}"));
    let _ = shell(&mut dev, &format!("rm -f {LOG_PATH}"));
    let _ = shell(&mut dev, "sync");

    println!("\n=== natartos removed, stock restored ===");
    println!("Reboot to return to fully stock goggles.");
}

fn cmd_status() {
    let mut dev = match device() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    };

    let version = shell(&mut dev, &format!(
        "grep -o '\"natartos_version\"[^,]*' {MANIFEST_DEVICE_PATH} 2>/dev/null | cut -d'\"' -f4 || echo '(not installed)'"
    )).unwrap_or_else(|e| format!("error: {e}"));
    let status = shell(&mut dev, &format!("cat {STATUS_PATH} 2>/dev/null || echo '(none)'"))
        .unwrap_or_else(|e| format!("error: {e}"));
    let bootcount = shell(&mut dev, &format!(
        "if [ -f {BOOTCOUNT_PATH} ]; then od -A n -t u4 -N 4 {BOOTCOUNT_PATH} | tr -d ' '; else echo 0; fi"
    )).unwrap_or_else(|e| format!("error: {e}"));
    let disabled = shell(&mut dev, &format!("[ -f {DISABLED_PATH} ] && echo yes || echo no"))
        .unwrap_or_else(|e| format!("error: {e}"));
    let log = shell(&mut dev, &format!("cat {LOG_PATH} 2>/dev/null || echo '(no log)'"))
        .unwrap_or_else(|e| format!("error: {e}"));

    println!("natartos status:");
    println!("  version:   {}", version.trim());
    println!("  state:     {}", status.trim());
    println!("  bootcount: {}", bootcount.trim());
    println!("  disabled:  {}", disabled.trim());
    println!("  log:");
    for line in log.lines() {
        println!("    {line}");
    }
}

fn cmd_safe(arg: Option<&str>) {
    let mut dev = match device() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    };

    match arg {
        Some("on") => {
            let _ = shell(&mut dev, &format!("touch {DISABLED_PATH}"));
            println!("kill-switch ON — mods disabled on next boot");
        }
        Some("off") => {
            let _ = shell(&mut dev, &format!("rm -f {DISABLED_PATH}"));
            let _ = shell(&mut dev, &format!("printf '\\x00\\x00\\x00\\x00' > {BOOTCOUNT_PATH}"));
            println!("kill-switch OFF + bootcount reset — mods enabled on next boot");
        }
        _ => {
            let disabled = shell(&mut dev, &format!("[ -f {DISABLED_PATH} ] && echo yes || echo no"))
                .unwrap_or_default();
            println!("kill-switch: {}", disabled.trim());
            eprintln!("usage: toolya natartos safe <on|off>");
        }
    }
}
