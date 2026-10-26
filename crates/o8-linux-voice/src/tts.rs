//! Linux system TTS floor: the counterpart of macOS `native_say`.
//!
//! Backends, in preference order (override with `O8_TTS_BACKEND`):
//! 1. `piper` — neural voice, used only when a voice model is configured
//!    (`O8_PIPER_MODEL`, or the first `*.onnx` in `~/.o8/models/piper/`) and a
//!    raw PCM player (`pw-play`, `paplay`, `aplay`) exists.
//! 2. `espeak-ng` / `espeak` — plays directly, so a kill stops it at once.
//! 3. `spd-say` — Speech Dispatcher; honours the user's desktop voice config.
//!
//! Every backend runs as a child process polled against `should_cancel`, the
//! same single-flight contract as `native_say::speak_with_say_cancellable`.
//! Default voices on all three are male, matching the macOS floor's choice.

use crate::tools;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub const NO_TTS_MESSAGE: &str = "no Linux text-to-speech engine found: install espeak-ng or speech-dispatcher (spd-say), or piper with a voice model";

const POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PcmPlayer {
    PwPlay(PathBuf),
    Paplay(PathBuf),
    Aplay(PathBuf),
}

impl PcmPlayer {
    fn detect(search_path: &OsStr) -> Option<Self> {
        tools::find_in("pw-play", search_path)
            .map(Self::PwPlay)
            .or_else(|| tools::find_in("paplay", search_path).map(Self::Paplay))
            .or_else(|| tools::find_in("aplay", search_path).map(Self::Aplay))
    }

    /// Command that plays signed 16-bit little-endian mono PCM from stdin.
    pub fn command(&self, rate: u32) -> Command {
        let (bin, args): (&Path, Vec<String>) = match self {
            Self::PwPlay(b) => (
                b,
                vec![
                    "--raw".into(),
                    format!("--rate={rate}"),
                    "--channels=1".into(),
                    "--format=s16".into(),
                    "-".into(),
                ],
            ),
            Self::Paplay(b) => (
                b,
                vec![
                    "--raw".into(),
                    format!("--rate={rate}"),
                    "--channels=1".into(),
                    "--format=s16le".into(),
                ],
            ),
            Self::Aplay(b) => (
                b,
                vec![
                    "-q".into(),
                    "-t".into(),
                    "raw".into(),
                    "-f".into(),
                    "S16_LE".into(),
                    "-c".into(),
                    "1".into(),
                    "-r".into(),
                    rate.to_string(),
                    "-".into(),
                ],
            ),
        };
        let mut cmd = Command::new(bin);
        cmd.args(args);
        cmd
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Backend {
    Piper {
        bin: PathBuf,
        model: PathBuf,
        sample_rate: u32,
        player: PcmPlayer,
    },
    Espeak(PathBuf),
    SpdSay(PathBuf),
}

impl Backend {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Piper { .. } => "piper",
            Self::Espeak(_) => "espeak-ng",
            Self::SpdSay(_) => "spd-say",
        }
    }
}

/// Piper voices ship a `<voice>.onnx.json` config carrying the sample rate.
pub fn piper_sample_rate(model: &Path) -> u32 {
    let mut config = model.as_os_str().to_owned();
    config.push(".json");
    std::fs::read_to_string(config)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["audio"]["sample_rate"].as_u64())
        .map(|r| r as u32)
        .unwrap_or(22_050)
}

/// The configured piper voice: `O8_PIPER_MODEL`, else the first `*.onnx` in
/// `~/.o8/models/piper/`.
pub fn configured_piper_model() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("O8_PIPER_MODEL").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let dir = crate::model::o8_data_dir().join("models").join("piper");
    let mut voices: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension() == Some(OsStr::new("onnx")))
        .collect();
    voices.sort();
    voices.into_iter().next()
}

/// Pick a backend. `preferred` (from `O8_TTS_BACKEND`) moves that engine to the
/// front when it is available.
pub fn detect(
    search_path: &OsStr,
    piper_model: Option<&Path>,
    preferred: Option<&str>,
) -> Option<Backend> {
    let piper = || {
        let model = piper_model.filter(|m| m.is_file())?;
        Some(Backend::Piper {
            bin: tools::find_in("piper", search_path)?,
            model: model.to_path_buf(),
            sample_rate: piper_sample_rate(model),
            player: PcmPlayer::detect(search_path)?,
        })
    };
    let espeak = || {
        tools::find_in("espeak-ng", search_path)
            .or_else(|| tools::find_in("espeak", search_path))
            .map(Backend::Espeak)
    };
    let spd = || tools::find_in("spd-say", search_path).map(Backend::SpdSay);
    match preferred.map(str::trim) {
        Some("piper") => piper().or_else(espeak).or_else(spd),
        Some("espeak-ng") | Some("espeak") => espeak().or_else(piper).or_else(spd),
        Some("spd-say") | Some("speech-dispatcher") => spd().or_else(piper).or_else(espeak),
        _ => piper().or_else(espeak).or_else(spd),
    }
}

pub fn detect_system() -> Option<Backend> {
    let preferred = std::env::var("O8_TTS_BACKEND").ok();
    detect(
        &tools::system_path(),
        configured_piper_model().as_deref(),
        preferred.as_deref(),
    )
}

/// espeak words/minute, matching `say -r 175*speed` on macOS.
pub fn espeak_rate(speed: f32) -> u32 {
    (175.0 * speed.clamp(0.1, 4.0)).round() as u32
}

/// spd-say rate is -100..=100 with 0 as the voice's normal pace.
pub fn spd_rate(speed: f32) -> i32 {
    (((speed - 1.0) * 100.0).round() as i32).clamp(-100, 100)
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Poll children until all exit (true when all succeeded) or `should_cancel`
/// fires (children are killed, false).
fn supervise(children: &mut [Child], should_cancel: &dyn Fn() -> bool) -> bool {
    let mut ok = vec![None; children.len()];
    loop {
        for (i, child) in children.iter_mut().enumerate() {
            if ok[i].is_none() {
                match child.try_wait() {
                    Ok(Some(status)) => ok[i] = Some(status.success()),
                    Ok(None) => {}
                    Err(_) => ok[i] = Some(false),
                }
            }
        }
        if ok.iter().all(Option::is_some) {
            return ok.iter().all(|s| *s == Some(true));
        }
        if should_cancel() {
            children.iter_mut().for_each(kill);
            return false;
        }
        std::thread::sleep(POLL);
    }
}

/// Speak `text` with `backend`, polling `should_cancel`. Returns whether it
/// ran to completion; cancellation and failures are both `false`.
pub fn speak_with(
    backend: &Backend,
    text: &str,
    speed: f32,
    should_cancel: &dyn Fn() -> bool,
) -> bool {
    if text.trim().is_empty() {
        return true;
    }
    match backend {
        Backend::Espeak(bin) => match Command::new(bin)
            .args(["-s", &espeak_rate(speed).to_string(), "--"])
            .arg(text)
            .stdout(Stdio::null())
            .spawn()
        {
            Ok(child) => supervise(&mut [child], should_cancel),
            Err(_) => false,
        },
        Backend::SpdSay(bin) => {
            let child = Command::new(bin)
                .args(["-N", "o8", "-w", "-r", &spd_rate(speed).to_string(), "--"])
                .arg(text)
                .stdout(Stdio::null())
                .spawn();
            let Ok(child) = child else { return false };
            let mut children = [child];
            let done = supervise(&mut children, should_cancel);
            if !done && should_cancel() {
                // Killing the client leaves the daemon talking; stop the
                // utterance that is currently playing (ours).
                let _ = Command::new(bin)
                    .arg("-S")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            done
        }
        Backend::Piper {
            bin,
            model,
            sample_rate,
            player,
        } => {
            let mut piper = Command::new(bin);
            piper.arg("--model").arg(model).arg("--output_raw");
            if (speed - 1.0).abs() > 0.01 {
                piper.args([
                    "--length_scale",
                    &format!("{:.3}", 1.0 / speed.clamp(0.25, 4.0)),
                ]);
            }
            let Ok(mut synth) = piper
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            else {
                return false;
            };
            let pcm = synth.stdout.take().expect("piped stdout");
            let play = player
                .command(*sample_rate)
                .stdin(Stdio::from(pcm))
                .stdout(Stdio::null())
                .spawn();
            let Ok(play) = play else {
                kill(&mut synth);
                return false;
            };
            if let Some(mut stdin) = synth.stdin.take() {
                let _ = stdin.write_all(text.replace('\n', " ").as_bytes());
                let _ = stdin.write_all(b"\n");
            }
            supervise(&mut [synth, play], should_cancel)
        }
    }
}

/// Drop-in for `native_say::speak_with_say_cancellable` on Linux.
pub fn speak_cancellable(text: &str, speed: f32, should_cancel: &dyn Fn() -> bool) -> bool {
    match detect_system() {
        Some(backend) => speak_with(&backend, text, speed, should_cancel),
        None => false,
    }
}

/// Outcome of a [`Speaker::speak`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeakOutcome {
    Completed,
    /// Superseded by `stop()` or a newer `speak()`.
    Cancelled,
    /// The engine exited with an error.
    Failed(String),
}

/// Single-flight system speaker: a new `speak` cancels the one in flight and
/// waits for it to exit before starting, and `stop` silences whatever plays.
pub struct Speaker {
    generation: AtomicU64,
    playing: Mutex<()>,
    resolve: Box<dyn Fn() -> Option<Backend> + Send + Sync>,
}

impl Default for Speaker {
    fn default() -> Self {
        Self::with_resolver(detect_system)
    }
}

impl Speaker {
    pub fn with_resolver(resolve: impl Fn() -> Option<Backend> + Send + Sync + 'static) -> Self {
        Self {
            generation: AtomicU64::new(0),
            playing: Mutex::new(()),
            resolve: Box::new(resolve),
        }
    }

    /// The backend a `speak` would use now (re-detected so newly installed
    /// tools are picked up without a restart).
    pub fn backend(&self) -> Option<Backend> {
        (self.resolve)()
    }

    /// Blocking. Errors only when no engine is installed.
    pub fn speak(&self, text: &str, speed: f32) -> Result<SpeakOutcome, String> {
        let mine = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let backend = self.backend().ok_or_else(|| NO_TTS_MESSAGE.to_string())?;
        let _turn = self.playing.lock().unwrap_or_else(|p| p.into_inner());
        let cancelled = || self.generation.load(Ordering::SeqCst) != mine;
        if cancelled() {
            return Ok(SpeakOutcome::Cancelled);
        }
        Ok(if speak_with(&backend, text, speed, &cancelled) {
            SpeakOutcome::Completed
        } else if cancelled() {
            SpeakOutcome::Cancelled
        } else {
            SpeakOutcome::Failed(format!("{} exited with an error", backend.name()))
        })
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{fake_tool, TempDir};
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn rates_track_macos_say() {
        assert_eq!(espeak_rate(1.0), 175);
        assert_eq!(espeak_rate(1.5), 263);
        assert_eq!(spd_rate(1.0), 0);
        assert_eq!(spd_rate(1.25), 25);
        assert_eq!(spd_rate(9.0), 100);
        assert_eq!(spd_rate(0.1), -90);
    }

    #[test]
    fn detection_order_and_override() {
        let dir = TempDir::new("tts-detect");
        assert_eq!(detect(dir.path().as_os_str(), None, None), None);
        fake_tool(dir.path(), "spd-say", "exit 0");
        let sp = dir.path().as_os_str();
        assert!(matches!(detect(sp, None, None), Some(Backend::SpdSay(_))));
        fake_tool(dir.path(), "espeak-ng", "exit 0");
        assert!(matches!(detect(sp, None, None), Some(Backend::Espeak(_))));
        assert!(matches!(
            detect(sp, None, Some("spd-say")),
            Some(Backend::SpdSay(_))
        ));

        // piper needs a voice model *and* a player.
        fake_tool(dir.path(), "piper", "exit 0");
        let model = dir.path().join("en_US-ryan-medium.onnx");
        std::fs::write(&model, b"onnx").unwrap();
        std::fs::write(
            dir.path().join("en_US-ryan-medium.onnx.json"),
            r#"{"audio":{"sample_rate":16000}}"#,
        )
        .unwrap();
        assert!(matches!(
            detect(sp, Some(&model), None),
            Some(Backend::Espeak(_))
        ));
        fake_tool(dir.path(), "aplay", "exit 0");
        match detect(sp, Some(&model), None) {
            Some(Backend::Piper {
                sample_rate,
                player: PcmPlayer::Aplay(_),
                ..
            }) => assert_eq!(sample_rate, 16000),
            other => panic!("expected piper, got {other:?}"),
        }
        assert!(matches!(
            detect(sp, Some(&model), Some("espeak-ng")),
            Some(Backend::Espeak(_))
        ));
    }

    #[test]
    fn espeak_receives_rate_and_text() {
        let dir = TempDir::new("tts-espeak");
        let log = dir.path().join("args");
        let bin = fake_tool(
            dir.path(),
            "espeak-ng",
            &format!("printf '%s|' \"$@\" > '{}'", log.display()),
        );
        assert!(speak_with(
            &Backend::Espeak(bin),
            "-hello world",
            1.0,
            &|| false
        ));
        assert_eq!(
            std::fs::read_to_string(log).unwrap(),
            "-s|175|--|-hello world|"
        );
    }

    #[test]
    fn failure_is_false_and_empty_text_is_a_noop() {
        let dir = TempDir::new("tts-fail");
        let bin = fake_tool(dir.path(), "espeak-ng", "exit 3");
        assert!(!speak_with(
            &Backend::Espeak(bin.clone()),
            "hi",
            1.0,
            &|| false
        ));
        assert!(speak_with(&Backend::Espeak(bin), "  ", 1.0, &|| false));
    }

    #[test]
    fn cancellation_kills_the_engine_and_stops_spd() {
        let dir = TempDir::new("tts-cancel");
        let stopped = dir.path().join("stopped");
        let bin = fake_tool(
            dir.path(),
            "spd-say",
            &format!(
                "if [ \"$1\" = -S ]; then touch '{}'; exit 0; fi; exec sleep 30",
                stopped.display()
            ),
        );
        let start = Instant::now();
        assert!(!speak_with(
            &Backend::SpdSay(bin),
            "long text",
            1.0,
            &|| start.elapsed() > Duration::from_millis(150)
        ));
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(
            stopped.exists(),
            "spd-say -S should silence the daemon after a cancel"
        );
    }

    #[test]
    fn piper_pipes_pcm_into_the_player() {
        let dir = TempDir::new("tts-piper");
        let got = dir.path().join("played");
        let piper = fake_tool(dir.path(), "piper", "read line; printf 'PCM:%s' \"$line\"");
        let aplay = fake_tool(dir.path(), "aplay", &format!("cat > '{}'", got.display()));
        let backend = Backend::Piper {
            bin: piper,
            model: dir.path().join("v.onnx"),
            sample_rate: 22050,
            player: PcmPlayer::Aplay(aplay),
        };
        assert!(speak_with(&backend, "two\nlines", 1.0, &|| false));
        assert_eq!(std::fs::read_to_string(got).unwrap(), "PCM:two lines");
    }

    #[test]
    fn speaker_is_single_flight() {
        let dir = TempDir::new("tts-speaker");
        let log = dir.path().join("log");
        let bin = fake_tool(
            dir.path(),
            "espeak-ng",
            &format!(
                "echo \"start $4\" >> '{0}'; sleep 0.4; echo \"end $4\" >> '{0}'",
                log.display()
            ),
        );
        let speaker = Arc::new(Speaker::with_resolver(move || {
            Some(Backend::Espeak(bin.clone()))
        }));
        let first = {
            let s = speaker.clone();
            std::thread::spawn(move || s.speak("one", 1.0))
        };
        std::thread::sleep(Duration::from_millis(150));
        let second = speaker.speak("two", 1.0).unwrap();
        assert_eq!(first.join().unwrap().unwrap(), SpeakOutcome::Cancelled);
        assert_eq!(second, SpeakOutcome::Completed);
        let log = std::fs::read_to_string(log).unwrap();
        assert_eq!(
            log, "start one\nstart two\nend two\n",
            "the first utterance must be killed before the second starts"
        );

        let s = speaker.clone();
        let third = std::thread::spawn(move || s.speak("three", 1.0));
        std::thread::sleep(Duration::from_millis(150));
        speaker.stop();
        assert_eq!(third.join().unwrap().unwrap(), SpeakOutcome::Cancelled);
    }

    #[test]
    fn speaker_reports_missing_engine_clearly() {
        let speaker = Speaker::with_resolver(|| None);
        assert_eq!(speaker.speak("hi", 1.0), Err(NO_TTS_MESSAGE.to_string()));
    }
}
