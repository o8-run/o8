//! Output-volume ducking through `pactl`, the Linux counterpart of
//! `src-tauri/src/audio_ducker.rs` (which drives `osascript` on macOS).
//!
//! `pactl` talks to PulseAudio and to PipeWire's `pipewire-pulse`, which
//! covers the mainstream desktops. When `pactl` is missing or no sound server
//! answers, ducking is a silent no-op.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

/// Fraction of the pre-duck volume kept while dictating (same as macOS).
pub const DUCK_SCALAR: f32 = 0.20;

/// Per-channel volume percentages from `pactl get-sink-volume`, e.g.
/// `Volume: front-left: 32768 /  50% / -18.06 dB,   front-right: 32768 /  50% / ...`.
pub fn parse_volume_percents(output: &str) -> Vec<u32> {
    let first_line = output.lines().find(|l| l.contains('%')).unwrap_or("");
    first_line
        .split_whitespace()
        .filter_map(|token| token.strip_suffix('%'))
        .filter_map(|n| n.parse::<u32>().ok())
        .collect()
}

pub fn ducked(volumes: &[u32]) -> Vec<u32> {
    volumes
        .iter()
        .map(|v| (*v as f32 * DUCK_SCALAR).round() as u32)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Saved {
    sink: String,
    volumes: Vec<u32>,
}

/// Remembers the pre-duck volume of the sink it lowered. Only the first
/// `duck()` since the last `restore()` takes effect.
pub struct Ducker {
    search_path: OsString,
    saved: Mutex<Option<Saved>>,
}

impl Ducker {
    pub const fn new(search_path: OsString) -> Self {
        Self {
            search_path,
            saved: Mutex::new(None),
        }
    }

    fn pactl(&self) -> Option<PathBuf> {
        crate::tools::find_in("pactl", &self.search_path)
    }

    fn run(pactl: &OsStr, args: &[&str]) -> Option<String> {
        let out = Command::new(pactl).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Lower the default sink. Returns whether a volume change was applied.
    /// Blocking (two or three short `pactl` calls); run it off the UI thread.
    pub fn duck(&self) -> bool {
        let mut saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        if saved.is_some() {
            return false;
        }
        let Some(pactl) = self.pactl() else {
            return false;
        };
        let pactl = pactl.as_os_str();
        // Pin the sink by name so restore() targets the same device even if the
        // default changes mid-dictation (e.g. headphones plugged in).
        let sink = Self::run(pactl, &["get-default-sink"])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "@DEFAULT_SINK@".to_string());
        let Some(volumes) =
            Self::run(pactl, &["get-sink-volume", &sink]).map(|o| parse_volume_percents(&o))
        else {
            return false;
        };
        // Already silent (or unreadable): nothing to duck, and saving a zero
        // would stop a later restore from ever raising it.
        if volumes.is_empty() || volumes.iter().all(|v| *v == 0) {
            return false;
        }
        if !set_volume(pactl, &sink, &ducked(&volumes)) {
            return false;
        }
        *saved = Some(Saved { sink, volumes });
        true
    }

    /// Restore the pre-duck volume. Idempotent; a no-op when nothing is ducked.
    pub fn restore(&self) -> bool {
        let Some(saved) = self.saved.lock().unwrap_or_else(|p| p.into_inner()).take() else {
            return false;
        };
        let Some(pactl) = self.pactl() else {
            return false;
        };
        set_volume(pactl.as_os_str(), &saved.sink, &saved.volumes)
    }

    pub fn is_ducked(&self) -> bool {
        self.saved
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }
}

fn set_volume(pactl: &OsStr, sink: &str, volumes: &[u32]) -> bool {
    let mut cmd = Command::new(pactl);
    cmd.args(["set-sink-volume", sink]);
    cmd.args(volumes.iter().map(|v| format!("{v}%")));
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Read a boolean from `~/.o8/dictation.json` with the same leniency as
/// `stt::keys::config_bool` on macOS (bools or "true"/"1"/"yes"/"on" strings).
pub fn voice_pref_bool(key: &str, default: bool) -> bool {
    let path = crate::model::o8_data_dir().join("dictation.json");
    let value = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    match value.as_ref().and_then(|v| v.get(key)) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => default,
        },
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{fake_tool, TempDir};

    #[test]
    fn parses_pactl_volume_lines() {
        let out = "Volume: front-left: 32768 /  50% / -18.06 dB,   front-right: 26214 /  40% / -23.88 dB\n        balance -0.20\n";
        assert_eq!(parse_volume_percents(out), vec![50, 40]);
        assert_eq!(
            parse_volume_percents("Volume: mono: 65536 / 100% / 0.00 dB"),
            vec![100]
        );
        assert!(parse_volume_percents("Connection failure").is_empty());
        assert_eq!(ducked(&[50, 40, 3]), vec![10, 8, 1]);
    }

    /// A fake `pactl` that keeps sink volumes in a file, like the real server.
    fn fake_pactl(dir: &TempDir, initial: &str) -> PathBuf {
        let state = dir.path().join("volume");
        let log = dir.path().join("log");
        std::fs::write(&state, initial).unwrap();
        fake_tool(
            dir.path(),
            "pactl",
            &format!(
                r#"echo "$@" >> '{log}'
case "$1" in
  get-default-sink) echo alsa_output.pci.analog-stereo ;;
  get-sink-volume) v=$(cat '{state}'); set -- $v; echo "Volume: front-left: 0 / $1 / 0 dB,   front-right: 0 / $2 / 0 dB" ;;
  set-sink-volume) echo "$3 $4" > '{state}' ;;
esac"#,
                log = log.display(),
                state = state.display()
            ),
        );
        state
    }

    #[test]
    fn ducks_once_and_restores_the_same_sink() {
        let dir = TempDir::new("duck");
        let state = fake_pactl(&dir, "50% 40%");
        let ducker = Ducker::new(dir.path().as_os_str().to_owned());
        assert!(ducker.duck());
        assert_eq!(std::fs::read_to_string(&state).unwrap().trim(), "10% 8%");
        // A second duck must not save the already-ducked level as the baseline.
        assert!(!ducker.duck());
        assert!(ducker.restore());
        assert_eq!(std::fs::read_to_string(&state).unwrap().trim(), "50% 40%");
        assert!(!ducker.restore(), "restore is idempotent");
        let log = std::fs::read_to_string(dir.path().join("log")).unwrap();
        assert!(
            log.contains("set-sink-volume alsa_output.pci.analog-stereo 50% 40%"),
            "{log}"
        );
    }

    #[test]
    fn silent_sink_and_missing_pactl_are_noops() {
        let dir = TempDir::new("duck-silent");
        fake_pactl(&dir, "0% 0%");
        let ducker = Ducker::new(dir.path().as_os_str().to_owned());
        assert!(!ducker.duck());
        assert!(!ducker.is_ducked());

        let empty = TempDir::new("duck-none");
        let ducker = Ducker::new(empty.path().as_os_str().to_owned());
        assert!(!ducker.duck());
        assert!(!ducker.restore());
    }
}
