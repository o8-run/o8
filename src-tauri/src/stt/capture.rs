//! Main-process microphone capture (#1540).
//!
//! macOS Sequoia 15.7.8 (2026-06-27) broke audio delivery to app-SPAWNED
//! helper processes on Intel: the helper's own AVAudioEngine receives silence
//! or garbage regardless of TCC state, while capture in the MAIN app process
//! keeps working (the composer/webview path never broke on the same machine —
//! the existence proof). This module owns the microphone in the app process —
//! the attribution macOS actually honors — and streams 16kHz mono f32 PCM to
//! the speech helper over a FIFO. The helper, in `--audio-fifo` mode, feeds
//! that stream to SFSpeechRecognizer + the Whisper WAV exactly as its own tap
//! used to.
//!
//! The pump stays open for a bounded 15-second linger after key-up. That keeps
//! back-to-back dictations off the cold device-open path (#1544) while retaining
//! the privacy boundary: no session activity extends the deadline forever.

#[cfg(target_os = "macos")]
use std::fs::OpenOptions;
#[cfg(target_os = "macos")]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

const TARGET_RATE: f64 = 16_000.0;
/// Frames per FIFO chunk — matches the helper's reader (1024 × f32 = 4096 B).
const CHUNK_FRAMES: usize = 1024;
/// Device-warmup floor (#1544): the first buffers off a freshly-opened input
/// carry device-warmup garbage, so we always drop this much captured audio
/// before anything reaches the FIFO. Measured at the SOURCE rate. The *tail of
/// whatever was playing before the duck landed* used to be lumped in here too
/// (hence the old 200ms); that concern now belongs to the duck-settle gate
/// below, so the pure device-warmup floor can be smaller.
const WARMUP_DISCARD_MS: f64 = 120.0;
const PUMP_LINGER: Duration = Duration::from_secs(15);

/// Lets the capture pump hold the start of a message until the audio duck has
/// actually lowered system volume — so playing audio can't bleed in before the
/// mic is effectively clear. The pump opens the device IMMEDIATELY (overlapping
/// the duck's osascript) and discards captured audio until BOTH the warmup floor
/// passes AND `settled` flips (or `cap` elapses). When nothing needs ducking the
/// caller flips `settled` right away, collapsing the gate to just the floor.
pub struct DuckGate {
    /// Shared flag the caller flips once the duck's first volume-set lands (or
    /// on any duck early-exit: nothing playing / ducking disabled).
    pub settled: Arc<AtomicBool>,
    /// Hard bound on how long the gate waits for `settled` before opening anyway.
    pub cap: Duration,
}

/// Whether the duck-settle half of the capture gate is open: settled already,
/// or its cap has elapsed. Pure for unit testing.
fn duck_gate_open(settled: bool, elapsed: Duration, cap: Duration) -> bool {
    settled || elapsed >= cap
}

/// Leading SOURCE frames to discard from one captured buffer given how many
/// warmup frames are still owed and whether the duck gate is open. Returns
/// `buffer_len` to drop the whole buffer (still waiting on the duck). Pure for
/// unit testing.
fn gate_discard(buffer_len: usize, warmup_frames_left: usize, duck_ready: bool) -> usize {
    let warmup_drop = warmup_frames_left.min(buffer_len);
    if duck_ready {
        warmup_drop
    } else {
        buffer_len
    }
}

pub struct AudioPump {
    fifo_path: PathBuf,
    running: Arc<AtomicBool>,
    control: Arc<Mutex<PumpControl>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

struct PumpControl {
    session_active: bool,
    session_generation: u64,
    duck_gate: Option<DuckGate>,
    linger_until: Option<Instant>,
    shutdown: bool,
}

impl Default for PumpControl {
    fn default() -> Self {
        Self {
            session_active: false,
            session_generation: 0,
            duck_gate: None,
            linger_until: None,
            shutdown: false,
        }
    }
}

fn should_close_lingering_pump(active: bool, linger_until: Option<Instant>, now: Instant) -> bool {
    !active && linger_until.is_some_and(|deadline| now >= deadline)
}

fn session_warmup_frames(cold_start: bool, cold_warmup_frames: usize) -> usize {
    if cold_start { cold_warmup_frames } else { 0 }
}

impl AudioPump {
    /// Create the FIFO node (idempotent) and return a stopped pump bound to it.
    pub fn new(fifo_path: PathBuf) -> Result<Self, String> {
        create_fifo(&fifo_path)?;
        Ok(Self {
            fifo_path,
            running: Arc::new(AtomicBool::new(false)),
            control: Arc::new(Mutex::new(PumpControl::default())),
            worker: None,
        })
    }

    pub fn fifo_path(&self) -> &Path {
        &self.fifo_path
    }

    /// Open the default input device and start streaming to the FIFO.
    /// No-op if already running. Errors are returned, not logged-and-lost —
    /// the caller surfaces them so a dead mic is never silent (#1534 lesson).
    ///
    /// `duck_gate` (when present) holds the start of the message until the audio
    /// duck has landed; `None` opens the gate immediately (only the warmup floor
    /// is paid). The device opens right away either way, overlapping the duck.
    pub fn start(&mut self, duck_gate: Option<DuckGate>) -> Result<(), String> {
        let mut duck_gate = duck_gate;
        let reused = {
            let mut control = self.control.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if self.running.load(Ordering::SeqCst) && !control.shutdown {
                control.session_active = true;
                control.session_generation = control.session_generation.wrapping_add(1);
                control.duck_gate = duck_gate.take();
                control.linger_until = None;
                true
            } else {
                false
            }
        };
        if reused {
            log::info!("[stt-capture] pump reused during 15s linger");
            return Ok(());
        }
        self.reap_worker();

        {
            let mut control = self.control.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            control.session_active = true;
            control.session_generation = control.session_generation.wrapping_add(1);
            control.duck_gate = duck_gate;
            control.linger_until = None;
            control.shutdown = false;
        }
        let running = Arc::clone(&self.running);
        running.store(true, Ordering::SeqCst);
        let control = Arc::clone(&self.control);
        let fifo_path = self.fifo_path.clone();

        // The cpal stream must live on a thread we control: streams are !Send
        // on macOS, so build + hold it inside the worker.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let worker = match std::thread::Builder::new()
            .name("stt-capture-pump".into())
            .spawn(move || pump_thread(fifo_path, running, control, ready_tx))
        {
            Ok(worker) => worker,
            Err(error) => {
                self.running.store(false, Ordering::SeqCst);
                return Err(format!("capture pump thread spawn failed: {error}"));
            }
        };
        self.worker = Some(worker);

        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                self.running.store(false, Ordering::SeqCst);
                Err(e)
            }
            Err(_) => {
                self.running.store(false, Ordering::SeqCst);
                Err("capture pump did not become ready within 5s".to_string())
            }
        }
    }

    /// Stop forwarding session audio, then release the device after a bounded
    /// linger so a follow-up dictation can reuse the already-warm stream.
    pub fn stop(&mut self) {
        if !self.running.load(Ordering::SeqCst) {
            return;
        }
        let mut control = self.control.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        control.session_active = false;
        control.duck_gate = None;
        control.linger_until = Some(Instant::now() + PUMP_LINGER);
        log::info!("[stt-capture] session stopped; pump lingering for 15s");
    }

    fn shutdown(&mut self) {
        {
            let mut control = self.control.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            control.session_active = false;
            control.duck_gate = None;
            control.linger_until = None;
            control.shutdown = true;
        }
        self.running.store(false, Ordering::SeqCst);
        self.reap_worker();
    }

    fn reap_worker(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for AudioPump {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn create_fifo(path: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    if path.exists() {
        return Ok(());
    }
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "fifo path contains NUL".to_string())?;
    let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if rc != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
        return Err(format!(
            "mkfifo({}) failed: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Main-process capture rides cpal, which only the macOS shell links. On Linux
/// the `o8-speech-recognizer` helper captures through PipeWire / PulseAudio
/// itself, so the pump refuses and `spawn_daemon` keeps helper-side capture.
#[cfg(not(target_os = "macos"))]
fn pump_thread(
    _fifo_path: PathBuf,
    _running: Arc<AtomicBool>,
    _control: Arc<Mutex<PumpControl>>,
    ready_tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let _ = ready_tx.send(Err(
        "main-process capture is macOS-only; the helper captures on this platform".to_string(),
    ));
}

/// Worker: open device → open FIFO (blocks until the helper's reader is
/// attached) → forward resampled mono PCM until stopped.
#[cfg(target_os = "macos")]
fn pump_thread(
    fifo_path: PathBuf,
    running: Arc<AtomicBool>,
    control: Arc<Mutex<PumpControl>>,
    ready_tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = ready_tx.send(Err("no default input device".to_string()));
        return;
    };
    let device_name = device.name().unwrap_or_else(|_| "unknown".to_string());

    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("input config for '{device_name}' failed: {e}")));
            return;
        }
    };
    let src_rate = config.sample_rate() as f64;
    let channels = config.channels() as usize;

    // Samples cross from the audio callback to this thread through a channel;
    // the callback must never block on FIFO I/O.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);

    let err_flag = Arc::new(AtomicBool::new(false));
    let err_flag_cb = Arc::clone(&err_flag);
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                    .collect();
                let _ = tx.try_send(mono);
            },
            move |e| {
                log::warn!("[stt-capture] input stream error: {e}");
                err_flag_cb.store(true, Ordering::SeqCst);
            },
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[i16], _| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| {
                        frame.iter().map(|s| *s as f32 / 32768.0).sum::<f32>() / channels as f32
                    })
                    .collect();
                let _ = tx.try_send(mono);
            },
            move |e| {
                log::warn!("[stt-capture] input stream error: {e}");
                err_flag_cb.store(true, Ordering::SeqCst);
            },
            None,
        ),
        other => {
            let _ = ready_tx.send(Err(format!("unsupported input sample format {other:?}")));
            return;
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("input stream open failed: {e}")));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(format!("input stream start failed: {e}")));
        return;
    }

    // Blocks until the helper opens its read end — it does so at boot in
    // --audio-fifo mode, so in practice this returns immediately.
    let mut fifo = match OpenOptions::new().write(true).open(&fifo_path) {
        Ok(f) => f,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("fifo open failed: {e}")));
            return;
        }
    };

    log::info!(
        "[stt-capture] pump live: '{device_name}' {src_rate}Hz {channels}ch → 16kHz mono → {}",
        fifo_path.display()
    );
    let _ = ready_tx.send(Ok(()));

    // Linear resampler state (speech-tolerant; both recognizers accept it).
    let ratio = src_rate / TARGET_RATE;
    let mut src_buf: Vec<f32> = Vec::with_capacity(8192);
    let mut src_pos = 0f64;
    let mut out_chunk: Vec<f32> = Vec::with_capacity(CHUNK_FRAMES);

    // Capture gate (#1544 overlap): discard captured audio until BOTH the
    // device-warmup floor has passed (measured in source frames) AND the audio
    // duck has settled (or its cap elapsed / nothing needed ducking). The device
    // opened above without waiting on the duck, so the duck's osascript has been
    // running in parallel — in the common no-music case the gate flips ready
    // before the first buffer even arrives and only the warmup floor is paid.
    // Total discard is bounded by warmup-floor + duck-cap worth of audio.
    let cold_warmup_floor_frames = (src_rate * WARMUP_DISCARD_MS / 1000.0) as usize;
    let mut warmup_floor_frames = cold_warmup_floor_frames;
    let mut warmup_frames_left = warmup_floor_frames;
    let mut duck_cap = Duration::ZERO;
    let mut duck_settled: Option<Arc<AtomicBool>> = None;
    let mut gate_start = Instant::now();
    let mut discarded_frames: usize = 0;
    let mut gate_open_logged = false;
    let mut active_generation = 0u64;
    let mut was_active = false;

    while running.load(Ordering::SeqCst) && !err_flag.load(Ordering::SeqCst) {
        let should_exit = {
            let state = control.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.shutdown || should_close_lingering_pump(
                state.session_active,
                state.linger_until,
                Instant::now(),
            ) {
                running.store(false, Ordering::SeqCst);
                true
            } else {
                false
            }
        };
        if should_exit {
            break;
        }

        let mut mono = match rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(m) => m,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        let session_update = {
            let mut state = control.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if !state.session_active {
                None
            } else if state.session_generation != active_generation {
                Some((state.session_generation, state.duck_gate.take()))
            } else {
                Some((active_generation, None))
            }
        };
        let Some((generation, new_duck_gate)) = session_update else {
            if was_active {
                src_buf.clear();
                src_pos = 0.0;
                out_chunk.clear();
                was_active = false;
            }
            continue;
        };

        if generation != active_generation {
            let cold_start = active_generation == 0;
            active_generation = generation;
            was_active = true;
            src_buf.clear();
            src_pos = 0.0;
            out_chunk.clear();
            warmup_floor_frames = session_warmup_frames(cold_start, cold_warmup_floor_frames);
            warmup_frames_left = warmup_floor_frames;
            duck_cap = new_duck_gate.as_ref().map_or(Duration::ZERO, |gate| gate.cap);
            duck_settled = new_duck_gate.map(|gate| gate.settled);
            gate_start = Instant::now();
            discarded_frames = 0;
            gate_open_logged = false;
        }

        if warmup_frames_left > 0 || !gate_open_logged {
            // `None` gate → duck half is open from the start (warmup floor only).
            let duck_ready = duck_settled.as_ref().map_or(true, |flag| {
                duck_gate_open(flag.load(Ordering::SeqCst), gate_start.elapsed(), duck_cap)
            });
            let drop_n = gate_discard(mono.len(), warmup_frames_left, duck_ready);
            warmup_frames_left -= warmup_frames_left.min(mono.len());
            if drop_n > 0 {
                discarded_frames += drop_n;
                mono.drain(..drop_n);
                if mono.is_empty() {
                    continue;
                }
            }
            // First audio past the gate — report how much we dropped and why.
            gate_open_logged = true;
            let discarded_ms = discarded_frames as f64 / src_rate * 1000.0;
            let warmup_ms = warmup_floor_frames as f64 / src_rate * 1000.0;
            let duck_wait_ms = (discarded_ms - warmup_ms).max(0.0);
            log::info!(
                "[voice] capture gate open: discarded {discarded_ms:.0}ms ({warmup_ms:.0}ms warmup + {duck_wait_ms:.0}ms duck-wait)"
            );
        }
        src_buf.extend_from_slice(&mono);

        while (src_pos as usize) + 1 < src_buf.len() {
            let base = src_pos as usize;
            let frac = (src_pos - base as f64) as f32;
            let sample = src_buf[base] * (1.0 - frac) + src_buf[base + 1] * frac;
            out_chunk.push(sample);
            src_pos += ratio;

            if out_chunk.len() == CHUNK_FRAMES {
                let bytes: &[u8] = unsafe {
                    std::slice::from_raw_parts(
                        out_chunk.as_ptr() as *const u8,
                        out_chunk.len() * std::mem::size_of::<f32>(),
                    )
                };
                if let Err(e) = fifo.write_all(bytes) {
                    log::warn!("[stt-capture] fifo write failed (helper gone?): {e}");
                    running.store(false, Ordering::SeqCst);
                    break;
                }
                out_chunk.clear();
            }
        }
        // Drop consumed source samples, keep the fractional remainder aligned.
        let consumed = src_pos as usize;
        if consumed > 0 {
            src_buf.drain(..consumed.min(src_buf.len()));
            src_pos -= consumed as f64;
        }
    }

    running.store(false, Ordering::SeqCst);
    drop(stream); // release the device — mic indicator off
    let _ = fifo.flush();
    log::info!("[stt-capture] pump stopped");
}

#[cfg(test)]
mod tests {
    use super::{
        duck_gate_open, gate_discard, session_warmup_frames, should_close_lingering_pump,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn linger_closes_only_after_deadline_while_idle() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(15);
        assert!(!should_close_lingering_pump(false, Some(deadline), now));
        assert!(should_close_lingering_pump(false, Some(deadline), deadline));
        assert!(!should_close_lingering_pump(true, Some(deadline), deadline));
        assert!(!should_close_lingering_pump(false, None, deadline));
    }

    #[test]
    fn warm_reuse_skips_the_cold_device_discard() {
        assert_eq!(session_warmup_frames(true, 5_760), 5_760);
        assert_eq!(session_warmup_frames(false, 5_760), 0);
    }

    #[test]
    fn duck_gate_opens_when_settled() {
        // Settled flips the gate open regardless of elapsed time.
        assert!(duck_gate_open(
            true,
            Duration::from_millis(0),
            Duration::from_millis(450)
        ));
    }

    #[test]
    fn duck_gate_waits_until_cap() {
        let cap = Duration::from_millis(450);
        // Not settled and under the cap → still closed.
        assert!(!duck_gate_open(false, Duration::from_millis(100), cap));
        // Not settled but cap reached / exceeded → open anyway (bounded wait).
        assert!(duck_gate_open(false, Duration::from_millis(450), cap));
        assert!(duck_gate_open(false, Duration::from_millis(600), cap));
    }

    #[test]
    fn gate_discard_pays_only_warmup_when_duck_ready() {
        // Warmup smaller than the buffer → drop just the warmup, keep the rest.
        assert_eq!(gate_discard(100, 30, true), 30);
        // Warmup larger than the buffer → drop the whole buffer (clamped).
        assert_eq!(gate_discard(50, 100, true), 50);
        // Fully warmed + duck ready → keep everything.
        assert_eq!(gate_discard(100, 0, true), 0);
    }

    #[test]
    fn gate_discard_drops_whole_buffer_while_duck_pending() {
        // Duck not ready → drop the whole buffer regardless of warmup left.
        assert_eq!(gate_discard(100, 0, false), 100);
        assert_eq!(gate_discard(100, 30, false), 100);
    }
}
