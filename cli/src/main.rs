//! toolya CLI (M0 scaffold). Only `duml-show` works offline; the rest are stubs
//! until hardware wiring lands per milestone (see ../PLAN.md). No command touches
//! the goggles yet.

mod info;
mod natartos;
mod reboot;
mod selinux;
mod usb;
mod usbmode;

use std::process::exit;

const STUBS: &[(&str, &str)] = &[
    ("shell", "M1 · one-shot wrapper over broken interactive shell"),
    ("log", "M1 · adb logcat"),
    ("push", "M1 · adb push"),
    ("pull", "M1 · adb pull"),
    ("power", "M2 · power off/on (cmd_id TBD)"),
    ("awake", "M2 · inhibit auto-sleep"),
    ("snap", "M3 · single frame"),
    ("stream", "M3 · video out to local window"),
    ("record", "M3 · stream to file"),
    ("tx", "M4 · transmitter off/on (cmd_id TBD)"),
    ("fan", "M4 · fan quiet/auto with temp guard"),
    ("temp", "M4 · temperature readout"),
    ("mute", "M4 · audio mute"),
    ("brightness", "M4 · display brightness"),
    ("backup", "M5 · dump a partition/config"),
    ("emu", "M6 · host-mode dev (research)"),
];

// `desk` profile: the sequence that puts the goggles into desk-dev mode.
const DESK_STEPS: &[&str] = &["adb", "awake", "tx off", "fan quiet", "stream"];

fn usage() {
    eprintln!("toolya {} — https://toolya.dev\n", env!("CARGO_PKG_VERSION"));
    eprintln!("usage: toolya <command> [args]\n");
    eprintln!("  duml-show adb-enable    print raw DUML packet (no hardware)");
    eprintln!("  info --from <f> [--usage <f>]  parse getprop/usage dumps (offline)");
    eprintln!("  usb <adb|rndis>         show USB-mode switch plan");
    eprintln!("  reboot [--hard]         show reboot plan (graceful / sysrq)");
    eprintln!("  selinux <status|permissive|enforcing> [--yes]  session SELinux toggle (devmem)");
    eprintln!("  natartos <sub>          install the natartos mod framework (versions/install/uninstall/status/safe)");
    eprintln!("  desk                    show desk-mode step sequence");
    for (n, d) in STUBS { eprintln!("  {:<22}  {}", n, d); }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    match cmd {
        "" | "-h" | "--help" => { usage(); exit(1); }
        "--version" => println!("toolya {} — https://toolya.dev\nCopyright (c) 2026 grom-labs. AGPL-3.0 + attribution term, see NOTICE.", env!("CARGO_PKG_VERSION")),
        "adb" => {
            // Informed-consent gate: this writes the DUML enable packet to the goggles.
            eprintln!(
                "⚠ toolya enables ADB/root on your DJI Goggles 3 — an unauthorized modification\n\
                 of your own device. It likely violates DJI's Terms of Service; DJI may suspend/ban\n\
                 your account and/or void your warranty. In practice unlikely (local, undetectable,\n\
                 reverts to stock on removal). Own hardware only; as-is, no warranty."
            );
            if !args.iter().any(|a| a == "--yes") {
                eprintln!("\nRe-run to proceed:  toolya adb --yes");
                exit(1);
            }
            // After ~5s USB reconfigures to ACM+ADB; connect via adb afterwards.
            let seq = 0x2711u16; // matches the verified vector; device ignores exact value
            match usb::Goggles::open().and_then(|g| g.send_duml(&toolya_core::adb_enable_pkt(seq))) {
                Ok(()) => println!("adb enable sent — wait ~5s, then `adb devices`"),
                Err(e) => { eprintln!("toolya adb: {e}"); exit(1); }
            }
        }
        "info" => {
            // Offline: `info --from <getprop> [--usage <glasses_statistics.json>]`.
            // Live read over adb is M1/hardware.
            let mut props_file = None;
            let mut usage_file = None;
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--from" => props_file = it.next(),
                    "--usage" => usage_file = it.next(),
                    _ => {}
                }
            }
            if props_file.is_none() && usage_file.is_none() {
                eprintln!("🔴 toolya info: live read needs adb (M1/hw). Offline: `info --from <getprop> [--usage /data/glasses_statistics.json]`");
                exit(2);
            }
            let read = |f: &str| std::fs::read_to_string(f).unwrap_or_else(|e| { eprintln!("info: read {f}: {e}"); exit(1); });
            let mut i = match props_file {
                Some(f) => info::Info::from_props(&info::parse_getprop(&read(f))),
                None => info::Info::default(),
            };
            if let Some(f) = usage_file {
                let (p, m) = info::parse_usage(&read(f));
                i.power_ons = p;
                i.motor_starts = m;
            }
            i.print();
        }
        "reboot" => {
            // Graceful by default; --hard uses sysrq (sync-first). Scaffold only.
            let hard = args.iter().any(|a| a == "--hard");
            let steps = if hard { reboot::sysrq() } else { reboot::graceful() };
            println!("reboot ({}) — device (adb root):", if hard { "sysrq --hard" } else { "graceful" });
            for c in &steps { println!("  {c}"); }
            if hard {
                println!("  ⚠ sysrq 'b' is an immediate reboot — the sync (echo s) runs first to protect /data.");
                println!("  ⚠ /proc/sysrq-trigger may be SELinux-denied (was, from su:s0).");
            }
            println!("  note: adb does not survive reboot — re-enable after (toolya adb).");
            eprintln!("🔴 not executed — mutates the device, drops the connection; run only on explicit go-ahead.");
            exit(2);
        }
        "usb" => {
            // Toggle USB mode: adb (acm,adb) ↔ rndis (keeps adb). Live switch needs
            // adb (root setprop) and re-enumerates USB — scaffold prints the plan.
            match args.get(1).map(String::as_str) {
                Some(m @ ("adb" | "rndis")) => {
                    let cfg = if m == "rndis" { usbmode::CFG_RNDIS } else { usbmode::CFG_ADB };
                    println!("usb {m} → sys.usb.config = {cfg}");
                    println!("device (adb root):");
                    for c in usbmode::setprop_sequence(cfg) { println!("  {c}"); }
                    if m == "rndis" {
                        println!("host (usb0):");
                        for c in usbmode::host_rndis_up() { println!("  {c}"); }
                        println!("  device RNDIS IP: {}", usbmode::RNDIS_DEVICE_IP);
                    }
                    eprintln!("🔴 not applied — live switch needs adb (M1/hw) + re-enumerates USB.");
                    exit(2);
                }
                _ => { eprintln!("usage: toolya usb <adb|rndis>  (uvc unsupported on ZV902)"); exit(1); }
            }
        }
        "selinux" => selinux::run(&args[1..]),
        "natartos" => natartos::run(&args[1..]),
        "desk" => {
            // Composition profile. Each step is itself a toolya command; wiring
            // lands as those commands get hardware support.
            println!("desk profile — sequence (each pending its own command/hardware):");
            for (i, s) in DESK_STEPS.iter().enumerate() {
                println!("  {}. toolya {s}", i + 1);
            }
            eprintln!("🔴 not runnable yet — underlying steps need hardware (M1–M4).");
            exit(2);
        }
        "duml-show" => match args.get(1).map(String::as_str) {
            Some("adb-enable") => {
                // seq 0x2711 reproduces the verified vector; real sends will increment
                let p = toolya_core::adb_enable_pkt(0x2711);
                println!("{}", p.iter().map(|b| format!("{:02x}", b)).collect::<String>());
            }
            other => { eprintln!("unknown action: {}", other.unwrap_or("<none>")); exit(1); }
        },
        name => match STUBS.iter().find(|(n, _)| *n == name) {
            Some((_, d)) => { eprintln!("🔴 toolya {}: not implemented yet — {}", name, d); exit(2); }
            None => { eprintln!("unknown command: {}\n", name); usage(); exit(1); }
        },
    }
}
