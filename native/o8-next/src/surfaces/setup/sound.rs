//! Setup's low-volume cues, ported from the desktop's onboarding-sound.ts:
//! the same notes, levels and envelopes, silent until turned on. Each cue is
//! rendered once to a small WAV in the app's data folder and played by the
//! system player, off the UI thread; with no player the cue is skipped.
use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Cue {
    Tick,
    Advance,
    Complete,
}
impl Cue {
    fn name(self) -> &'static str {
        match self {
            Cue::Tick => "tick",
            Cue::Advance => "advance",
            Cue::Complete => "complete",
        }
    }
    /// Each voice: frequency (Hz), start and length (seconds), peak gain.
    fn voices(self) -> &'static [(f32, f32, f32, f32)] {
        match self {
            Cue::Tick => &[(640., 0., 0.045, 0.018)],
            // A soft two-note rise: a step forward.
            Cue::Advance => &[(523.25, 0., 0.09, 0.022), (783.99, 0.045, 0.12, 0.018)],
            // A gentle major triad bloom.
            Cue::Complete => &[
                (523.25, 0., 0.24, 0.022),
                (659.25, 0.035, 0.25, 0.018),
                (783.99, 0.07, 0.28, 0.016),
            ],
        }
    }
}

const RATE: u32 = 44_100;
const FLOOR: f32 = 0.0001;
const ATTACK: f32 = 0.012;

/// A sine voice under the desktop envelope: an exponential rise from the
/// floor to its peak over 12 ms, then an exponential fall to the floor at its
/// end, stopping 20 ms later.
fn level(t: f32, start: f32, length: f32, peak: f32) -> f32 {
    let t = t - start;
    if !(0. ..length + 0.02).contains(&t) {
        return 0.;
    }
    let ramp = |from: f32, to: f32, at: f32| from * (to / from).powf(at.clamp(0., 1.));
    if t < ATTACK {
        ramp(FLOOR, peak, t / ATTACK)
    } else {
        ramp(peak, FLOOR, (t - ATTACK) / (length - ATTACK))
    }
}

/// The cue as 16-bit mono PCM in a WAV container.
pub(crate) fn wav(cue: Cue) -> Vec<u8> {
    let voices = cue.voices();
    let seconds = voices
        .iter()
        .map(|(_, start, length, _)| start + length + 0.02)
        .fold(0., f32::max);
    let frames = (seconds * RATE as f32).ceil() as u32;
    let mut out = Vec::with_capacity(44 + frames as usize * 2);
    let data = frames * 2;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for frame in 0..frames {
        let t = frame as f32 / RATE as f32;
        let sample: f32 = voices
            .iter()
            .map(|&(freq, start, length, peak)| {
                level(t, start, length, peak) * (std::f32::consts::TAU * freq * (t - start)).sin()
            })
            .sum();
        let pcm = (sample.clamp(-1., 1.) * i16::MAX as f32) as i16;
        out.extend_from_slice(&pcm.to_le_bytes());
    }
    out
}

/// The cue's file in `dir`, written once (and again if it was changed).
fn file(dir: &Path, cue: Cue) -> Option<PathBuf> {
    let path = dir.join(format!("onboarding-{}.wav", cue.name()));
    let bytes = wav(cue);
    if std::fs::read(&path).ok().as_deref() != Some(&bytes[..]) {
        std::fs::create_dir_all(dir).ok()?;
        let partial = dir.join(format!(
            ".onboarding-{}.wav.{}",
            cue.name(),
            std::process::id()
        ));
        std::fs::write(&partial, &bytes).ok()?;
        std::fs::rename(&partial, &path).ok()?;
    }
    Some(path)
}

/// The system's sound player: afplay on macOS, else PulseAudio's or ALSA's.
fn player() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        return Some("afplay");
    }
    let path = std::env::var_os("PATH")?;
    ["paplay", "aplay"]
        .into_iter()
        .find(|name| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
}

/// The cue now playing; a new cue replaces it, as on the desktop.
static PLAYING: Mutex<Option<Child>> = Mutex::new(None);

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static LAST: Cell<Option<Instant>> = const { Cell::new(None) };
    #[cfg(test)]
    static PLAYED: RefCell<Vec<Cue>> = const { RefCell::new(Vec::new()) };
}

/// Where cue files go, and whether cues play. Setup sets both as it opens.
pub(crate) fn configure(on: bool, dir: Option<PathBuf>) {
    ON.with(|value| value.set(on));
    DIR.with(|value| *value.borrow_mut() = dir);
}
pub(crate) fn on() -> bool {
    ON.with(Cell::get)
}
pub(crate) fn set_on(on: bool) {
    ON.with(|value| value.set(on));
    if !on {
        stop();
    }
}
/// Quietly end the cue that is playing.
fn stop() {
    if let Some(mut child) = PLAYING.lock().ok().and_then(|mut playing| playing.take()) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Play a cue when sounds are on. Ticks closer than 75 ms apart are dropped.
/// Fire and forget: the file write and the player run on their own thread.
pub(crate) fn play(cue: Cue) {
    if !on() {
        return;
    }
    let now = Instant::now();
    if cue == Cue::Tick
        && LAST
            .with(Cell::get)
            .is_some_and(|last| now - last < Duration::from_millis(75))
    {
        return;
    }
    LAST.with(|value| value.set(Some(now)));
    #[cfg(test)]
    PLAYED.with(|played| played.borrow_mut().push(cue));
    let Some(dir) = DIR.with(|dir| dir.borrow().clone()) else {
        return;
    };
    std::thread::spawn(move || {
        let Some(path) = file(&dir, cue) else { return };
        // Tests write the files but never make a sound.
        if cfg!(test) {
            return;
        }
        let Some(player) = player() else { return };
        stop();
        let child = Command::new(player)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let (Ok(child), Ok(mut playing)) = (child, PLAYING.lock()) {
            *playing = Some(child);
        }
        // Collect the finished player so it never lingers.
        std::thread::sleep(Duration::from_secs(2));
        if let Ok(mut playing) = PLAYING.lock()
            && playing
                .as_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(Some(_))))
        {
            playing.take();
        }
    });
}

/// The cues played on this thread since the last call.
#[cfg(test)]
pub(crate) fn played() -> Vec<Cue> {
    PLAYED.with(|played| std::mem::take(&mut *played.borrow_mut()))
}

#[cfg(test)]
#[test]
fn cues_match_the_desktop_notes_and_stay_quiet() {
    for cue in [Cue::Tick, Cue::Advance, Cue::Complete] {
        let bytes = wav(cue);
        assert_eq!(&bytes[..4], b"RIFF");
        let samples: Vec<i16> = bytes[44..]
            .chunks(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let loudest = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
        // The desktop's peaks are 0.016 to 0.022 of full scale; voices overlap.
        assert!(
            (400..=1_500).contains(&loudest),
            "{cue:?} peaks at {loudest}"
        );
        assert!(
            samples.last().unwrap().unsigned_abs() < 10,
            "{cue:?} ends silent"
        );
    }
    // The tick is 45 ms plus the 20 ms tail; the bloom ends 70 + 280 + 20 ms in.
    assert_eq!(
        wav(Cue::Tick).len(),
        44 + 2 * (0.065f32 * 44_100.).ceil() as usize
    );
    assert_eq!(
        wav(Cue::Complete).len(),
        44 + 2 * (0.37f32 * 44_100.).ceil() as usize
    );
}
