# toolya — release roadmap

Guiding principles (from hard experience, not vibes):
- **The method leaks the moment it's usable.** Don't bet on scarcity. The moat is being
  **first, canonical, open, maintained**, plus the ecosystem (natartos) — not a paywall.
- **Open + donations, never a toll.** Rooting your own device shouldn't cost money or
  require begging for a key. Support (Ko-fi/crypto) keeps it going; it'll be here either way.
- **Ship honest.** Nothing is "done" until it's verified on real goggles. The UI/README
  advertise only what actually works.
- **The window is closing.** Other groups have G3 root (visor, others). Verify and launch
  rather than teaser-and-wait — a teaser just starts the race.

Status legend: ✅ done · 🔶 partial · ⬜ not started · ⛔ blocker.

---

## Phase 0 — Prove the core on hardware  ✅ (done)

Verified on a real DJI Goggles 3 over WebUSB (Chrome, Mac).

- ✅ **Enable → Connect → root shell** end-to-end. Enable needed the full method
  (handshake + cmd_id scan; the enable id shifts between boots) — not a single packet.
- ✅ **adb RSA auth** accepted in-browser.
- ✅ **REPL returns command output** (the on-device interactive shell is broken; the
  one-shot line-editor REPL over ya-webadb works).
- ✅ **usage counters** read. 🔶 **screen grab** pulls a correct 8 MB frame, but the
  on-device hook (v4) dumps the stale injection buffer instead of the live frame — a
  hook fix (researcher thread), not a toolya bug.

## Phase 1 — Harden + trim  🔶

Make the shipped surface match reality.

- ⬜ **Trim the UI/README to what's verified.** Keep: enable, shell, usage, background. Gate or
  hide anything unproven (screen = needs the on-device hook; fan/mute/tx/power = scaffolds).
- ✅ **Error paths:** goggles-not-found, auth-rejected, disconnect mid-op → friendly messages
  (`friendlyError`/`reportAdbError`; mid-op drops reset to disconnected). Verify on hardware.
- ✅ **Platform notes:** Windows WinUSB/Zadig guide (README Setup section + Zadig link in-app);
  browser/secure-context requirements.
- ✅ Informed-consent disclaimer (web modal + CLI `--yes` + README Risks).
- **DoD:** every visible control works on hardware; no dead buttons.

## Phase 2 — Open-source + compliance  🔶

Be publishable and AGPL-clean.

- ⬜ **Push repos** to `grom-labs` (toolya public) → the AGPL `source` link resolves (fixes §13:
  the hosted app must offer its source).
- ✅ **Fully open, no key:** all access-key gating removed; the enable plan is computed
  in-browser via WASM. No server, no key — toolya.dev is the canonical open instance.
- 🔶 **Final scrub:** no serials/keys in code or git history; `THIRD-PARTY-NOTICES` current. ✅ licenses (AGPL-3.0).
- ⬜ **GitHub CI** mirroring `toolya-check`; issue templates; `CONTRIBUTING.md`.
- **DoD:** repos public, AGPL-clean, CI green on GitHub.

## Phase 3 — Public launch  ⬜ (be first + canonical)

- ✅ **Open in-browser (WASM), no server/key.** toolya.dev is the canonical open instance.
- ⬜ **Write-up / announcement:** what it does + the method (it's open now), credit the community.
- ⬜ **Be in the FPV channels** where people look; Support visible.
- **DoD:** anyone opens toolya.dev, plugs in, is root — free and open.

## Phase 4 — natartos v0  ⬜ (post-launch: the ecosystem / moat)

On-device framework, built on the now-confirmed primitives (persistence + code_exec +
display_access).

- ⬜ **Modloader** — formalize the vendor-init + LD_PRELOAD mechanism.
- ⬜ **Brick-prevention** — boot-counter safe mode (skip mods after N failed boots; reset on a
  healthy-boot signal), fail-open hooks, kill-switch file, stock backups for uninstall.
- ⬜ **On-device SDK** — a thin `display_access` wrapper + package format + `install <file|URL>`.
- ⬜ **First mods** — persistent background / simple overlay; then **Doom** (doomgeneric +
  Freedoom, own repo, GPL) as the flagship.
- ⬜ **`toolya cast`** — stream a PC screen to the goggles via the fb_shared pipeline (host side).
- **DoD:** one persistent mod installs and survives reboot, with brick-prevention proven.

---

## Parallel track — researcher (via `toolya-contract.toml`)

toolya consumes these as they land (`toolya-sync`); it never guesses.

- ✅ live_screen pipeline (grab trigger + path + stream transport), persistence, code_exec, display_access.
- ⬜ **ui_hook** — inject a menu item into the DJI launcher (the one primitive natartos apps need).
- ⬜ **input map** — goggles buttons → linux keycodes (for Doom and any on-device input).
- ⬜ cmd_ids for `tx_off`, `power_off`, `usb_switch_duml`; locate `splash`.

## Non-goals for v1

- No opkg **server** — distribute mods via GitHub Releases; a static index only if/when there are many.
- No on-device apps in the toolya v1 — those are natartos, post-launch.
- No paywall, ever.
