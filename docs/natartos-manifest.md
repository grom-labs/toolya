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
    "device_path": "/vendor/etc/init/dji_glasses_custom.rc",
    "content": "service dji_glasses /system/bin/dji_glasses -g -f\n  override\n  disabled\n  user root\n  setenv LD_PRELOAD /vendor/lib64/natartos_loader.so\n"
  },

  "loader": {
    "file": "natartos_loader.so",
    "device_path": "/vendor/lib64/natartos_loader.so",
    "mode": "0644",
    "sha256": "<hex>"
  },

  "mods": [
    { "file": "hook_debug.so", "device_path": "/vendor/natartos/mods/hook_debug.so", "mode": "0644", "sha256": "<hex>" }
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
| `loader` / `mods[]` | `file` fetched (release asset or `--local` dir), **sha256 verified**, pushed to `device_path`, `chmod mode`. |
| `backup[]` | before writing, `cp <path> /vendor/natartos/stock/<basename>.orig` if not already backed up. Enables `uninstall`. |
| `remove[]` | deleted on the device during install (stale/superseded files). |

### Install flow (toolya, given a verified manifest)
1. connect, confirm `device` + `min_toolya`.
2. `mount -o remount,rw /vendor`; `mkdir -p /vendor/natartos/{stock,mods}`.
3. back up every `backup[]` path (idempotent).
4. verify sha256 of loader + each mod against the manifest; **abort all** on any mismatch.
5. push loader + mods to their `device_path`, `chmod`.
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
