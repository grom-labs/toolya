# natartos release manifest — contract between natartos and toolya

toolya is a **generic installer**: it never hardcodes natartos's on-device layout.
Every natartos release ships a `manifest.json` that describes exactly what to place
where. toolya reads it, verifies each artifact's `sha256`, and applies it over adb.

This file is the **interface** between the two repos:
- **natartos** (its CI / `scripts/build.sh`) *emits* `manifest.json` + the artifacts + `SHA256SUMS`.
- **toolya** (`cli/src/natartos.rs`, later the web panel) *consumes* it.

Change the schema only by bumping `schema` and updating both sides.

## Release assets (GitHub Releases, per tag)

A natartos release (e.g. `v0.2.0`) attaches:
- `manifest.json` — this document's schema.
- every file named in the manifest (`natartos_loader.so`, each mod `.so`).
- `SHA256SUMS` — `sha256  filename` lines for all of the above (belt-and-suspenders;
  toolya primarily trusts the per-artifact `sha256` inside the manifest).

`--local <dir>` (dev): the same `manifest.json` + artifacts sitting in a local folder
(what `scripts/build.sh` produces), so the natartos dev installs their fresh build
without cutting a release.

## Schema (schema = 1)

```json
{
  "schema": 1,
  "natartos_version": "v0.2.0",
  "device": "E3T zv902",
  "min_toolya": "0.1.0",

  "init_rc": {
    "device_path": "/vendor/etc/init/natartos.rc",
    "content": "service natartos_inject /system/bin/sh /vendor/natartos/inject.sh\n    oneshot\n    disabled\n    user root\n\non property:dji.glasses_service=1\n    start natartos_inject\n"
  },

  "loader": {
    "file": "natartos_loader.so",
    "device_path": "/vendor/lib64/natartos_loader.so",
    "mode": "0644",
    "sha256": "<hex>"
  },

  "mods": [
    {
      "id": "screen",
      "name": "Screen mirror",
      "description": "Grab/stream the goggles display over adb (LiveView hook).",
      "provides": "screen",
      "default": true,
      "file": "hook_debug.so",
      "device_path": "/vendor/natartos/mods/hook_debug.so",
      "mode": "0644",
      "sha256": "<hex>"
    }
  ],

  "files": [
    {
      "file": "inject.sh",
      "device_path": "/vendor/natartos/inject.sh",
      "mode": "0755",
      "sha256": "<hex>"
    },
    {
      "file": "adb_persist.sh",
      "device_path": "/vendor/natartos/adb_persist.sh",
      "mode": "0755",
      "sha256": "<hex>"
    }
  ],

  "backup": [
    "/vendor/etc/init/dji_glasses_custom.rc",
    "/vendor/etc/selinux/precompiled_sepolicy"
  ],

  "remove": [
    "/vendor/etc/init/persist_adb.rc",
    "/vendor/lib64/hook_debug.so",
    "/vendor/lib64/hook_bitmap.so"
  ]
}
```

### Field semantics (how toolya applies it)

| Field | Meaning / toolya action |
|---|---|
| `schema` | manifest version. toolya refuses an unknown `schema`. |
| `natartos_version` | human tag; shown in `status` / install log. |
| `device` | must match the connected goggles model (`ro.product.*`); mismatch → refuse. |
| `min_toolya` | toolya refuses to install if its own version is older. |
| `init_rc.content` | written verbatim to `init_rc.device_path` (mode 0644). The **only** source of the `.rc`; toolya does not synthesize it. |
| `loader` | `file` fetched (release asset or `--local` dir), **sha256 verified**, pushed to `device_path`, `chmod mode`. Always installed. |
| `files[]` | non-selectable required artifacts (shell scripts, config). Same fields as `loader` (`file`/`device_path`/`mode`/`sha256`). Always installed alongside the loader — not shown in the mod picker. |
| `mods[]` | selectable units. Each has `id` (stable, for selection + telemetry), `name` + `description` (UI), optional `provides` (a capability tag like `screen`/`background`/`splash` the UI gates a panel on), `default` (preselected when true), and the artifact fields (`file`/`device_path`/`mode`/`sha256`). The user picks which mods to install; only chosen ones are fetched + pushed. |
| `backup[]` | before writing, `cp <path> /vendor/natartos/stock/<basename>.orig` if not already backed up. Enables `uninstall`. |
| `remove[]` | deleted on the device during install (stale/superseded files). |

## Mod selection, custom mods, and install telemetry

- **Selection.** Install is not all-or-nothing: the UI lists `mods[]` by `name`/`description`,
  preselects the `default:true` ones, and installs only the chosen set (plus the loader).
  A device-side record (`/vendor/natartos/installed.json` or the applied manifest) tracks
  which mod `id`s are active so `status`/`uninstall` know what's there.
- **`provides`.** A panel like Screen/Background/Splash is gated on its provider mod being
  installed; otherwise it shows "needs the `<provides>` mod".
- **Custom mods.** The user may add their own `.so` (file picker / `--local`): it's pushed
  to `/vendor/natartos/mods/<name>` under the same path rules, but it is **not** part of a
  signed release, so toolya marks it untrusted and never reports telemetry for it.
- **Install telemetry (anonymous).** On a successful install, toolya may record one
  `mod_install` event per installed **release** mod `id` + the natartos version — counts
  only, no device/user data, honoring the same consent/DNT as other stats. Custom mods are
  never reported. The CLI has no disclaimer, so it **must prompt for consent** (or require a
  `--stats` flag) before sending anything.

### Install flow (toolya, given a verified manifest)
1. connect, confirm `device` + `min_toolya`.
2. `mount -o remount,rw /vendor`; `mkdir -p /vendor/natartos/{stock,mods}`.
3. back up every `backup[]` path (idempotent).
4. verify sha256 of loader + each file + each mod against the manifest; **abort all** on any mismatch.
5. push loader + `files[]` + chosen mods to their `device_path`, `chmod`.
6. delete `remove[]` paths.
7. write `init_rc.content` → `init_rc.device_path`.
8. clear stale anti-brick state (`bootcount`/`status`/`disabled`), `sync`.
9. tell the user to reboot, then `toolya natartos status`.

`uninstall` is manifest-independent: it restores `/vendor/natartos/stock/*.orig` and
removes `/vendor/natartos` + the loader, so an old install is removable without the
original manifest.

## Integrity note

The loader is a system-wide **root LD_PRELOAD**. toolya treats a sha256 mismatch as
fatal (never pushes), and only downloads over https from the `grom-labs/natartos`
release. Pin a version (`--version`); `install` defaults to the latest non-prerelease.
