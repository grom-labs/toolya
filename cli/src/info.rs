//! Device info: parse `getprop` output into fields. Pure + tested; the actual
//! gathering over adb is M1/hardware. Usage counters (power-ons / motor starts)
//! live in a /data config and are filled in once that file is identified on hw.
use std::collections::HashMap;

/// Parse `getprop` lines of the form `[key]: [value]`.
pub fn parse_getprop(text: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = parse_line(line) {
            m.insert(k, v);
        }
    }
    m
}

fn parse_line(line: &str) -> Option<(String, String)> {
    let line = line.trim().strip_prefix('[')?;
    let (k, rest) = line.split_once("]:")?;
    let rest = rest.trim_start().strip_prefix('[')?;
    let v = rest.strip_suffix(']')?;
    Some((k.to_string(), v.to_string()))
}

/// Extract an integer value for `key` from JSON-ish text (no JSON dep needed).
pub fn json_u64(text: &str, key: &str) -> Option<u64> {
    let pat = format!("\"{key}\"");
    let after = &text[text.find(&pat)? + pat.len()..];
    let after = &after[after.find(':')? + 1..];
    let num: String = after
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    num.parse().ok()
}

/// Usage counters from /data/glasses_statistics.json.
pub fn parse_usage(text: &str) -> (Option<u64>, Option<u64>) {
    (json_u64(text, "glasses_boot_cnt"), json_u64(text, "motor_start_cnt"))
}

/// Mask a serial: keep first 2 and last 2 chars, stars between.
pub fn mask(s: &str) -> String {
    let n = s.chars().count();
    if n <= 4 {
        return "*".repeat(n);
    }
    let first: String = s.chars().take(2).collect();
    let last: String = s.chars().skip(n - 2).collect();
    format!("{first}{}{last}", "*".repeat(n - 4))
}

#[derive(Debug, Default)]
pub struct Info {
    pub model: Option<String>,
    pub fw: Option<String>,
    pub serial_masked: Option<String>,
    pub power_ons: Option<u64>,   // TODO(hw): from /data config
    pub motor_starts: Option<u64>, // TODO(hw): from /data config
}

impl Info {
    pub fn from_props(p: &HashMap<String, String>) -> Self {
        Info {
            model: p.get("ro.product.model").cloned(),
            fw: p
                .get("ro.build.display.id")
                .or_else(|| p.get("ro.build.version.incremental"))
                .cloned(),
            serial_masked: p.get("ro.serialno").map(|s| mask(s)),
            power_ons: None,
            motor_starts: None,
        }
    }

    pub fn print(&self) {
        let f = |o: &Option<String>| o.clone().unwrap_or_else(|| "?".into());
        let n = |o: &Option<u64>| o.map(|v| v.to_string()).unwrap_or_else(|| "? (needs /data file)".into());
        println!("model:        {}", f(&self.model));
        println!("firmware:     {}", f(&self.fw));
        println!("serial:       {}", f(&self.serial_masked));
        println!("power-ons:    {}", n(&self.power_ons));
        println!("motor starts: {}", n(&self.motor_starts));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SAMPLE: &str = "[ro.product.model]: [E3T zv902]\n\
                          [ro.serialno]: [987654321ABCDEF]\n\
                          [ro.build.display.id]: [PD1A.180720.031]\n";
    #[test]
    fn parses_and_masks() {
        let p = parse_getprop(SAMPLE);
        let i = Info::from_props(&p);
        assert_eq!(i.model.as_deref(), Some("E3T zv902"));
        assert_eq!(i.fw.as_deref(), Some("PD1A.180720.031"));
        assert_eq!(i.serial_masked.as_deref(), Some("98***********EF"));
    }
    #[test]
    fn mask_short() {
        assert_eq!(mask("ab"), "**");
        assert_eq!(mask("abcdef"), "ab**ef");
    }
    #[test]
    fn usage_counters() {
        let s = "{\n\t\"glasses_boot_cnt\":\t123,\n\t\"motor_start_cnt\":\t957\n}";
        assert_eq!(parse_usage(s), (Some(123), Some(957)));
    }
}
