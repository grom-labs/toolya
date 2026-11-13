//! Reboot strategies for DJI Goggles 3.
//!
//! Normal `reboot(2)` returned EINVAL and `sys.powerctl` failed, so sysrq is the fallback. CRITICAL: always sync before
//! a sysrq reboot — /data holds live state (glasses_statistics.json, us.db,
//! volume.json). A bare `echo b` is an unsynced hard reboot and can corrupt it.
//! Note: /proc/sysrq-trigger was SELinux-denied from su:s0 before — may still be.

/// Graceful attempt (preferred).
pub fn graceful() -> Vec<String> {
    vec!["svc power reboot || setprop sys.powerctl reboot".into()]
}

/// sysrq fallback — sync, settle, then reboot. Steps come from the contract.
pub fn sysrq() -> Vec<String> {
    toolya_core::contract::proc::REBOOT_SYSRQ
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sysrq_syncs_before_reboot() {
        let s = sysrq();
        let sync = s.iter().position(|c| c.contains("echo s >")).unwrap();
        let boot = s.iter().position(|c| c.contains("echo b >")).unwrap();
        assert!(sync < boot, "must sync before reboot to protect /data");
    }
}
