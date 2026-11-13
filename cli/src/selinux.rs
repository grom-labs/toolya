//! toolya selinux — session SELinux permissive toggle.
//!
//! `setenforce 0` is neverallow-blocked on the G3 (only the kernel domain may call
//! it), so toolya pokes the `selinux_state` enforce byte via `busybox devmem`. This
//! is session-only: it resets to Enforcing on reboot. For a permissive state that
//! survives reboot, use natartos (its sepolicy typepermissive patch on /vendor).
//!
//! Addresses are kernel-build-specific and come from the contract
//! (`toolya_core::contract::selinux`), not hardcoded here.

use adb_client::usb::ADBUSBDevice;
use adb_client::ADBDeviceExt;
use std::process::exit;
use toolya_core::contract::selinux::{ENFORCE_OFFSET, STATE_ADDRS};

fn connect() -> ADBUSBDevice {
    match ADBUSBDevice::autodetect() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("USB device not found: {e}");
            exit(1);
        }
    }
}

fn shell(dev: &mut ADBUSBDevice, cmd: &str) -> Result<String, String> {
    let mut out = Vec::new();
    let none: Option<&mut dyn std::io::Write> = None;
    dev.shell_command(&cmd, Some(&mut out as &mut dyn std::io::Write), none)
        .map_err(|e| format!("shell: {e}"))?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Scan the known selinux_state addresses and set the enforce byte.
/// `byte` is "0x00" (permissive) or "0x01" (enforcing). uint32@state is
/// 0x01000100 (enforcing) or 0x01000000 (permissive); we match either and write.
fn set_shell(byte: &str) -> String {
    let addrs = STATE_ADDRS.join(" ");
    format!(
        "for A in {addrs}; do V=$(busybox devmem $A 32 2>/dev/null) || continue; \
case \"$V\" in 0x01000100|0x01000000) busybox devmem $(printf 0x%X $((A+{ENFORCE_OFFSET}))) 8 {byte}; break;; esac; done; getenforce"
    )
}

pub fn run(args: &[String]) {
    let sub = args.first().map(String::as_str).unwrap_or("status");
    let confirmed = args.iter().any(|a| a == "--yes");

    match sub {
        "status" => {
            let mut dev = connect();
            match shell(&mut dev, "getenforce") {
                Ok(s) => println!("SELinux: {}", s.trim()),
                Err(e) => {
                    eprintln!("{e}");
                    exit(1);
                }
            }
        }
        "permissive" | "enforcing" => {
            let byte = if sub == "permissive" { "0x00" } else { "0x01" };
            if !confirmed {
                eprintln!("⚠ toolya selinux {sub} writes kernel memory (devmem) on your goggles.");
                eprintln!("  Session-only — SELinux returns to Enforcing on reboot.");
                eprintln!("  Re-run with --yes:  toolya selinux {sub} --yes");
                exit(1);
            }
            let mut dev = connect();
            match shell(&mut dev, &set_shell(byte)) {
                Ok(s) => {
                    let now = s.trim();
                    println!("SELinux: {now}");
                    let want = if sub == "permissive" { "Permissive" } else { "Enforcing" };
                    if !now.eq_ignore_ascii_case(want) {
                        eprintln!("(no known selinux_state address matched — kernel build may be new; ask the researcher to add its address)");
                        exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("{e}");
                    exit(1);
                }
            }
        }
        _ => {
            eprintln!("usage: toolya selinux <status|permissive|enforcing> [--yes]");
            exit(1);
        }
    }
}
