//! Desk profile: the sequence that puts the goggles into desk-development mode.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Ready,
    Pending,
    Unavailable,
}

impl StepStatus {
    fn icon(self) -> &'static str {
        match self {
            Self::Ready => "✓",
            Self::Pending => "○",
            Self::Unavailable => "✗",
        }
    }
}

pub struct DeskStep {
    pub name: &'static str,
    pub desc: &'static str,
    pub status: StepStatus,
}

pub struct DeskProfile {
    pub steps: Vec<DeskStep>,
}

impl DeskProfile {
    pub fn detect() -> Self {
        DeskProfile {
            steps: vec![
                DeskStep { name: "adb", desc: "root shell (via toolya adb)", status: StepStatus::Pending },
                DeskStep { name: "awake", desc: "keep display awake (M2)", status: StepStatus::Pending },
                DeskStep { name: "tx off", desc: "disable transmitter (M4)", status: StepStatus::Pending },
                DeskStep { name: "fan quiet", desc: "quiet fan mode (M4)", status: StepStatus::Pending },
                DeskStep { name: "stream", desc: "live screen output (M3)", status: StepStatus::Pending },
            ],
        }
    }

    pub fn print(&self) {
        println!("desk profile — puts the goggles into development mode:");
        for (i, s) in self.steps.iter().enumerate() {
            println!("  {}. {} {:<12} {}", i + 1, s.status.icon(), s.name, s.desc);
        }
    }
}

pub fn run() {
    let profile = DeskProfile::detect();
    profile.print();
    if profile.steps.iter().any(|s| s.status == StepStatus::Pending) {
        eprintln!("🔴 not runnable yet — pending steps need hardware (M1–M4).");
        std::process::exit(2);
    }
}
