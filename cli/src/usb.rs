//! Native USB transport for DUML (DJI Goggles 3). Pure Rust via nusb.
//!
//! Device: VID 0x2CA3 / PID 0x0020 (pre-adb config). The DUML service lives on
//! interface 4, bulk EP_OUT 0x04 / EP_IN 0x85 (per reference/enable_adb.py).
//! WARNING: send_duml() writes to the goggles — only call on explicit intent.

pub const VID: u16 = 0x2CA3;
pub const PID: u16 = 0x0020;
pub const IFACE: u8 = 4;
pub const EP_OUT: u8 = 0x04;
#[allow(dead_code)] pub const EP_IN: u8 = 0x85; // for reply reads (M1 hw)

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
            .claim_interface(IFACE)
            .map_err(|e| format!("claim interface {IFACE}: {e}"))?;
        Ok(Self { iface })
    }

    /// Send one DUML frame on the bulk OUT endpoint.
    pub fn send_duml(&self, frame: &[u8]) -> Result<(), String> {
        pollster::block_on(async {
            self.iface
                .bulk_out(EP_OUT, frame.to_vec())
                .await
                .into_result()
                .map(|_| ())
                .map_err(|e| format!("bulk out: {e}"))
        })
    }
}
