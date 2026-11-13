//! USB mode switching for DJI Goggles 3 (adb ↔ rndis).
//!
//! Controlled by the `sys.usb.config` property (setup_usb.sh owns it; does not
//! survive reboot — no persist trigger). RNDIS mode keeps `acm,adb` in the config
//! so adb access is not lost. Switching re-enumerates USB.
//!
//! RNDIS network (known-good): device 192.168.60.2, host usb0 192.168.60.1/24.

// sys.usb.config values come from the contract (single source of truth).
pub use toolya_core::contract::usb::{ADB as CFG_ADB, RNDIS as CFG_RNDIS};
pub const RNDIS_HOST_CIDR: &str = "192.168.60.1/24";
pub const RNDIS_DEVICE_IP: &str = "192.168.60.2";

/// Device-side sequence to apply a usb config (run as root over adb).
pub fn setprop_sequence(cfg: &str) -> Vec<String> {
    vec![
        "setprop sys.usb.config none".into(),
        "sleep 2".into(),
        format!("setprop sys.usb.config {cfg}"),
    ]
}

/// Host-side commands to bring up the RNDIS link after switching.
pub fn host_rndis_up() -> Vec<String> {
    vec![
        format!("ip addr add {RNDIS_HOST_CIDR} dev usb0"),
        "ip link set usb0 up".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rndis_keeps_adb() {
        assert!(CFG_RNDIS.contains("adb"), "rndis config must keep adb");
        assert!(CFG_RNDIS.contains("rndis"));
    }
    #[test]
    fn sequence_resets_then_sets() {
        let s = setprop_sequence(CFG_ADB);
        assert_eq!(s.first().unwrap(), "setprop sys.usb.config none");
        assert_eq!(s.last().unwrap(), "setprop sys.usb.config acm,adb");
    }
}
