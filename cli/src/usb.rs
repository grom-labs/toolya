//! Native USB transport for DUML (DJI Goggles 3). Pure Rust via nusb.
//!
//! Uses `toolya_core::enable_plan()` — same plan the Web client executes over
//! WebUSB. The transport differs (nusb vs WebUSB), the protocol is shared.

use toolya_core::EnablePlan;

pub const VID: u16 = 0x2CA3;
pub const PID: u16 = 0x0020;

pub struct Goggles {
    iface: nusb::Interface,
}

impl Goggles {
    /// Find and open the goggles in DUML (pre-adb) mode.
    pub fn open() -> Result<Self, String> {
        let di = nusb::list_devices()
            .map_err(|e| format!("list usb: {e}"))?
            .find(|d| d.vendor_id() == VID && d.product_id() == PID)
            .ok_or_else(|| format!(
                "goggles not found (VID {VID:#06x} PID {PID:#06x}) — plugged in, in DUML mode?"
            ))?;
        let dev = di.open().map_err(|e| format!("open device: {e}"))?;
        let iface = dev
            .claim_interface(4)
            .map_err(|e| format!("claim interface 4: {e}"))?;
        Ok(Self { iface })
    }

    fn bulk_out(&self, ep: u8, data: &[u8]) -> Result<(), String> {
        pollster::block_on(async {
            self.iface
                .bulk_out(ep, data.to_vec())
                .await
                .into_result()
                .map(|_| ())
                .map_err(|e| format!("bulk out: {e}"))
        })
    }

    fn bulk_in(&self, ep: u8, max: usize) -> Result<Vec<u8>, String> {
        pollster::block_on(async {
            self.iface
                .bulk_in(ep, nusb::transfer::RequestBuffer::new(max))
                .await
                .into_result()
                .map_err(|e| format!("bulk in: {e}"))
        })
    }

    /// Execute the full adb-enable plan: handshake → cmd_id scan.
    /// Returns Ok on USB disconnect (= ADB enabling) or Err on failure.
    pub fn run_enable(&self, plan: &EnablePlan, log: impl Fn(&str)) -> Result<(), String> {
        // Drain stale data
        for _ in 0..15 {
            if self.bulk_in(plan.ep_in | 0x80, 65536).is_err() { break; }
        }

        log("handshake…");
        // Send init + probe packets, accumulate IN data, watch for `expect`
        let mut blob = Vec::new();
        let mut got_expect = false;
        for (i, pkt) in plan.handshake.iter().enumerate() {
            if got_expect { break; }
            if self.bulk_out(plan.ep_out, pkt).is_err() { break; }
            let delay = if i < plan.init_count { 50 } else { 60 };
            std::thread::sleep(std::time::Duration::from_millis(delay));
            // Read whatever is available
            if let Ok(data) = self.bulk_in(plan.ep_in | 0x80, 65536) {
                blob.extend_from_slice(&data);
                if contains_subslice(&blob, &plan.expect) {
                    got_expect = true;
                }
            }
        }
        // Give reader a moment to catch the tail
        for _ in 0..20 {
            if got_expect { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
            if let Ok(data) = self.bulk_in(plan.ep_in | 0x80, 65536) {
                blob.extend_from_slice(&data);
                if contains_subslice(&blob, &plan.expect) {
                    got_expect = true;
                }
            }
        }
        if !got_expect {
            log("handshake: no </dji> (goggles may be asleep) — trying enable anyway…");
        } else {
            log("handshake ok");
        }

        // Drain before scan
        std::thread::sleep(std::time::Duration::from_millis(200));
        for _ in 0..15 {
            if self.bulk_in(plan.ep_in | 0x80, 65536).is_err() { break; }
        }

        // cmd_id scan: send candidates until write fails (= USB disconnect = success)
        log("enabling adb (scanning cmd_id)…");
        for pkt in &plan.candidates {
            match self.bulk_out(plan.ep_out, pkt) {
                Err(_) => {
                    log("adb enabling — goggles re-enumerate in ~5s. Then `adb devices`.");
                    return Ok(());
                }
                Ok(()) => {}
            }
            // Read response, skip broadcasts
            for _ in 0..8 {
                match self.bulk_in(plan.ep_in | 0x80, 1024) {
                    Ok(r) if r.len() >= 11 && r[8] == 0xC0 && r[10] == pkt[10] => {
                        let ret = if r.len() > 11 { r[11] } else { 0 };
                        if ret == 0xE0 { break; } // firewall block, try next
                        break;
                    }
                    Ok(_) => continue,
                    Err(_) => {
                        log("adb enabling — goggles re-enumerate in ~5s. Then `adb devices`.");
                        return Ok(());
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Err("no cmd_id triggered USB disconnect — keep the goggles awake and try again".into())
    }
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}
