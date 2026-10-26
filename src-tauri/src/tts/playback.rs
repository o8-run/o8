//! Audio playback for TTS — a session-managed, single-flight, chunked engine.
//!
//! `rodio::OutputStream`/`Sink`/`Decoder` are `!Send` and held across `.await`,
//! so they CANNOT run on Tauri's multithread async runtime (`async_runtime::
//! spawn`) — it won't compile. Every playback runs on a DEDICATED OS thread with
//! a `new_current_thread` tokio runtime built INSIDE it; synthesis (async
//! reqwest) and decode/play happen on that same thread, never crossing a
//! boundary. Ported from aqua `reading.rs` (the `ReadingSession` + chunked
//! Speak-Selection pipeline).
//!
//! Two problems this fixes over the old fire-and-forget `play_thread`:
//!   1. **Stacking.** Every old call spawned its own `OutputStream`+`Sink` with
//!      no registry — re-triggering during a slow synth stacked overlapping
//!      audio with no way to stop it. Now a module-global `CONTROLS` holds the
//!      single active sink + a `generation` counter; a new speak STOPS the old
//!      (single-flight), and `stop()` / `toggle_pause()` reach the live sink.
//!   2. **Latency.** A long selection synthesized into ONE MP3 before any audio
//!      played (~41s for 4k chars). Now text is split into chunks — a short
//!      ~200-char lead chunk returns in ~1-2s and starts playing while the rest
//!      synthesize via a one-chunk lookahead, so there is no silent gap.
//!
//! **Concurrency invariant:** the `(generation, is_active, sink)` triple is only
//! mutated while holding the sink mutex (the prelude, `stop`, the publish, and
//! the per-chunk append all take it). That serialization is what makes
//! single-flight race-free — a superseded thread can never re-raise `is_active`
//! after a `stop`, nor append into the winner's sink, because its in-lock
//! `generation == my_gen` check fails. The `say` fallback is generation-polled
//! so it is killable the same way.
//!
//! Diagnostics use `log::` (NOT `tracing::`) so they reach the bundled-app log
//! at `~/Library/Logs/ai.o8.desktop/o8.log` (the tracing subscriber writes to
//! stdout, which a Finder-launched .app discards). EVERY failure path before any
//! audio plays falls back to the macOS `say` binary so the user always hears
//! SOMETHING; a failure MID-read stops cleanly to keep the voice consistent.

use super::TtsConfig;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout, Duration};

// Speed is applied PITCH-PRESERVING at synthesis time (ElevenLabs
// `voice_settings.speed`, Google `speakingRate`) — NOT via rodio `set_speed`,
// which resampled and shifted pitch (2× = chipmunk, operator-rejected
// 2026-06-11). So a speed change takes effect on the NEXT utterance; there is
// no live re-rate of the audio already decoded.

/// Maximum characters per chunk before sentence-boundary splitting.
const MAX_CHUNK_CHARS: usize = 800;
/// The first chunk is kept short so the initial TTS round-trip returns fast and
/// audio starts with minimal perceived latency.
const LEAD_CHUNK_CHARS: usize = 200;
/// Polling interval while waiting for a chunk to finish playing.
const POLL_INTERVAL_MS: u64 = 100;
/// Per-chunk synth timeout + retry budget (long chunks can take >15s).
const CHUNK_TIMEOUT_SECS: u64 = 45;
const CHUNK_RETRIES: usize = 1;

/// Shared control handles for the single active TTS playback. Module-global so
/// `play_thread` (start), `stop`, and `toggle_pause` all reach the same sink.
struct Controls {
    /// True while a playback is actively producing audio — including the `say`
    /// fallback, so Ctrl+Shift+S / Escape route to `stop()` rather than starting a
    /// second voice. Mutated only under the `sink` lock.
    is_active: Arc<AtomicBool>,
    /// True after a speak call claims generation but before audio is active.
    /// This covers the synth-before-sink gap so queued status callouts do not
    /// supersede a pending answer.
    is_pending: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    /// The live rodio `Sink`, created inside the playback thread and stored here
    /// so `stop` / `toggle_pause` can reach it. Also the serialization mutex for
    /// the whole `(generation, is_active, sink)` triple.
    sink: Arc<Mutex<Option<rodio::Sink>>>,
    /// Bumped on every new speak AND on every `stop`. The playback thread
    /// captures its generation up front and bails the instant a newer speak (or
    /// a stop) supersedes it — the belt to `is_active`'s suspenders.
    generation: Arc<AtomicU64>,
}

impl Controls {
    fn new() -> Self {
        Self {
            is_active: Arc::new(AtomicBool::new(false)),
            is_pending: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            sink: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

static CONTROLS: OnceLock<Controls> = OnceLock::new();

fn controls() -> &'static Controls {
    CONTROLS.get_or_init(Controls::new)
}

/// Lock the sink mutex, recovering the guard on poison — a poisoned sink slot is
/// not a correctness concern (we only ever store/take/stop a `Sink`).
fn lock_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Returns true while a TTS playback is active (used to make Ctrl+Shift+S a
/// toggle and to route Escape to a stop). True during the `say` fallback too.
pub fn is_active() -> bool {
    controls().is_active.load(Ordering::SeqCst)
}

fn is_busy() -> bool {
    let ctl = controls();
    ctl.is_pending.load(Ordering::SeqCst) || ctl.is_active.load(Ordering::SeqCst)
}

/// Stop the active playback immediately. Bumps the generation (so any in-flight
/// synth/say thread bails before touching the now-stopped sink) under the sink
/// lock so a concurrently-publishing thread can't re-raise `is_active` after we
/// clear it. Safe no-op when nothing is playing.
pub fn stop() {
    let ctl = controls();
    let was_active;
    {
        let mut guard = lock_recover(&ctl.sink);
        ctl.generation.fetch_add(1, Ordering::SeqCst);
        ctl.is_pending.store(false, Ordering::SeqCst);
        was_active = ctl.is_active.swap(false, Ordering::SeqCst);
        ctl.is_paused.store(false, Ordering::SeqCst);
        if let Some(sink) = guard.take() {
            sink.stop();
        }
    }
    if was_active {
        log::info!("[tts] stop: playback halted");
    }
    emit_tts_state("idle");
}

/// Toggle pause / resume on the active playback. Returns the resulting paused
/// state (`true` = now paused). No-op (returns false) when nothing is playing.
pub fn toggle_pause() -> bool {
    let ctl = controls();
    if !ctl.is_active.load(Ordering::SeqCst) {
        return false;
    }
    let guard = lock_recover(&ctl.sink);
    if let Some(sink) = guard.as_ref() {
        if ctl.is_paused.load(Ordering::SeqCst) {
            sink.play();
            ctl.is_paused.store(false, Ordering::SeqCst);
            log::info!("[tts] resumed");
            emit_tts_state("playing");
            return false;
        } else {
            sink.pause();
            ctl.is_paused.store(true, Ordering::SeqCst);
            log::info!("[tts] paused");
            emit_tts_state("paused");
            return true;
        }
    }
    ctl.is_paused.load(Ordering::SeqCst)
}

/// Speak `text` with `config` on a dedicated OS thread (fire-and-forget, but
/// single-flight: a new call STOPS the previous playback). Any failure before
/// audio plays falls back to the macOS `say` binary. Returns immediately;
/// playback happens off-thread.
///
/// Thin wrapper: every non-message caller (Symon, filler, term-watch, agent
/// confirms, the Ask answer path) keeps the classic no-messageId behavior —
/// `build_chunks` chunking and no `o8:tts-chunk` events — byte-for-byte
/// unchanged from before voice-playback line highlighting existed.
pub fn play_thread(text: String, config: TtsConfig) {
    play_thread_with_message(text, config, None);
}

/// Speak one governed utterance and resolve `true` only after every audio chunk
/// finishes naturally. Stop, supersession, synthesis failure, or fallback
/// interruption resolve `false`, allowing callers to keep a protected action
/// behind the audible review instead of racing the confirmation card.
pub fn play_thread_with_completion(text: String, config: TtsConfig) -> oneshot::Receiver<bool> {
    let (sender, receiver) = oneshot::channel();
    play_thread_inner(text, config, None, Some(sender));
    receiver
}

/// Queue a short lifecycle callout behind any pending/active utterance. The
/// actual audio still uses the normal single-flight playback path; this wrapper
/// only waits its turn so callouts do not cut off Symon's final answer.
pub fn play_status_queued(text: String, config: TtsConfig) {
    if text.trim().is_empty() {
        return;
    }
    static STATUS_QUEUE: OnceLock<Mutex<()>> = OnceLock::new();
    let queue = STATUS_QUEUE.get_or_init(|| Mutex::new(()));
    std::thread::spawn(move || {
        let _guard = lock_recover(queue);
        while is_busy() {
            std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
        }
        play_thread(text, config);
        while is_busy() {
            std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
        }
    });
}

/// Speak `text`, optionally attributing playback to `message_id`. When `Some`
/// (the message play button), the ORIGINAL text is chunked at BLOCK (`\n\n`)
/// boundaries with byte spans (`build_chunks_with_spans`) and an `o8:tts-chunk`
/// event fires as each chunk STARTS playing, so the renderer can highlight the
/// spoken line. When `None`, the classic `build_chunks` path runs and no new
/// event is emitted.
pub fn play_thread_with_message(text: String, config: TtsConfig, message_id: Option<String>) {
    play_thread_inner(text, config, message_id, None);
}

fn play_thread_inner(
    text: String,
    config: TtsConfig,
    message_id: Option<String>,
    completion: Option<oneshot::Sender<bool>>,
) {
    if text.trim().is_empty() {
        if let Some(sender) = completion {
            let _ = sender.send(false);
        }
        return;
    }

    // Spans index into the ORIGINAL text (exactly what the renderer paints), so
    // capture it BEFORE the lossy speech normalization below.
    let raw_text = text.clone();

    // Normalize for SPEECH only (the displayed/pasted text keeps the original):
    // strip markdown/ANSI/tables/code-fences, expand currency/units/numbers, and
    // shorten URLs + file paths so the voice doesn't read code/prices/links as
    // gibberish. The chunker + say-fallback both operate on this spoken form.
    let text = crate::speech_text::prepare_text_for_speech(&text);
    if text.trim().is_empty() {
        if let Some(sender) = completion {
            let _ = sender.send(false);
        }
        return;
    }

    let ctl = controls();
    // Single-flight prelude: claim a fresh generation, clear is_active, and stop
    // whatever is playing — ALL under the sink lock so the (generation,
    // is_active, sink) triple moves atomically vs `stop` and the publish below.
    let my_gen;
    {
        let mut guard = lock_recover(&ctl.sink);
        my_gen = ctl.generation.fetch_add(1, Ordering::SeqCst) + 1;
        ctl.is_pending.store(true, Ordering::SeqCst);
        ctl.is_active.store(false, Ordering::SeqCst);
        ctl.is_paused.store(false, Ordering::SeqCst);
        if let Some(sink) = guard.take() {
            sink.stop();
        }
    }

    let is_active = ctl.is_active.clone();
    let is_pending = ctl.is_pending.clone();
    let is_paused = ctl.is_paused.clone();
    let sink_slot = ctl.sink.clone();
    let generation = ctl.generation.clone();

    std::thread::spawn(move || {
        struct CompletionGuard {
            sender: Option<oneshot::Sender<bool>>,
            completed: bool,
        }
        impl Drop for CompletionGuard {
            fn drop(&mut self) {
                if let Some(sender) = self.sender.take() {
                    let _ = sender.send(self.completed);
                }
            }
        }
        let mut completion = CompletionGuard {
            sender: completion,
            completed: false,
        };
        let speed = config.speed;

        // Supersession bail BEFORE any dock/state emit, so a thread that already
        // lost the race never flips the dock to "playing" (which nothing would
        // then clear). Only the current generation owns the active dock state.
        if generation.load(Ordering::SeqCst) != my_gen {
            return;
        }

        log::info!(
            "[tts] play_thread: {} chars, provider {} (gen {my_gen})",
            text.len(),
            provider_label(&config)
        );

        // Morph the screen dock to show TTS is active. The guard returns it to
        // idle on EVERY exit path — but ONLY if this thread is still the current
        // generation, so a superseded thread doesn't stomp the newer playback.
        emit_tts_state("playing");
        crate::sound::play_sound("ReadStart"); // read-aloud start cue (#1208)
        struct DockGuard {
            generation: Arc<AtomicU64>,
            is_pending: Arc<AtomicBool>,
            my_gen: u64,
        }
        impl Drop for DockGuard {
            fn drop(&mut self) {
                if self.generation.load(Ordering::SeqCst) == self.my_gen {
                    self.is_pending.store(false, Ordering::SeqCst);
                    emit_tts_state("idle");
                    crate::sound::play_sound("ReadDone"); // read-aloud finish cue (#1208)
                }
            }
        }
        let _dock_guard = DockGuard {
            generation: generation.clone(),
            is_pending: is_pending.clone(),
            my_gen,
        };

        // Current-thread tokio runtime, built INSIDE this OS thread so the
        // !Send rodio handles never cross a thread boundary.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[tts] failed to build playback runtime: {e}; falling back to say");
                completion.completed = run_say_fallback(
                    &text,
                    speed,
                    message_id.as_deref(),
                    None,
                    &is_active,
                    &is_pending,
                    &sink_slot,
                    &generation,
                    my_gen,
                );
                return;
            }
        };

        let mut tts_failed_before_audio = false;
        let mut fallback_error = None;
        let mut playback_completed = false;

        rt.block_on(async {
            // Chunk the text. With a messageId we split at BLOCK boundaries and
            // carry each chunk's source span so the renderer can highlight the
            // spoken line; otherwise the classic chunker (identical to legacy).
            let chunk_specs: Vec<(String, Option<(usize, usize)>)> = if message_id.is_some() {
                let spans = build_chunks_with_spans(&raw_text);
                if spans.is_empty() {
                    vec![(text.clone(), None)]
                } else {
                    spans
                        .into_iter()
                        .map(|c| (c.text, Some((c.src_start, c.src_end))))
                        .collect()
                }
            } else {
                let chunks = build_chunks(&text);
                let chunks = if chunks.is_empty() {
                    vec![text.clone()]
                } else {
                    chunks
                };
                chunks.into_iter().map(|t| (t, None)).collect()
            };
            log::info!("[tts] split into {} chunk(s)", chunk_specs.len());

            // Audio device + sink, created on this thread.
            let (_stream, handle) = match rodio::OutputStream::try_default() {
                Ok(pair) => pair,
                Err(e) => {
                    log::error!("[tts] no audio output device ({e}); falling back to say");
                    tts_failed_before_audio = true;
                    return;
                }
            };
            let sink = match rodio::Sink::try_new(&handle) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[tts] failed to create audio sink ({e}); falling back to say");
                    tts_failed_before_audio = true;
                    return;
                }
            };

            // Publish OUR sink + raise is_active ATOMICALLY with the gen check,
            // under the lock — so a `stop`/new-speak that already bumped the
            // generation is observed here and we bail without clobbering its
            // state.
            {
                let mut guard = lock_recover(&sink_slot);
                if generation.load(Ordering::SeqCst) != my_gen {
                    return;
                }
                *guard = Some(sink);
                is_active.store(true, Ordering::SeqCst);
                is_pending.store(false, Ordering::SeqCst);
                is_paused.store(false, Ordering::SeqCst);
            }

            let mut any_chunk_played = false;
            let mut stopped_mid_read = false;

            // One-chunk lookahead: `pending` always holds the audio for chunk
            // `i`, synthesized on the previous iteration, so there is no silent
            // network gap between chunks.
            let mut pending = Some(synthesize_chunk(&chunk_specs[0].0, &config, 0).await);

            for i in 0..chunk_specs.len() {
                // Stop / supersede check between chunks.
                if !is_active.load(Ordering::SeqCst) || generation.load(Ordering::SeqCst) != my_gen
                {
                    stopped_mid_read = true;
                    break;
                }

                let chunk_audio = pending
                    .take()
                    .unwrap_or_else(|| Err("missing prefetched audio".to_string()));

                let appended: Result<(), String> = match chunk_audio {
                    Ok(audio_bytes) => {
                        log::info!("[tts] chunk {i}: {} bytes", audio_bytes.len());
                        match rodio::Decoder::new(std::io::Cursor::new(audio_bytes)) {
                            Ok(decoder) => {
                                // Read the generation INSIDE the sink lock so the
                                // gen check and the append are atomic — a
                                // superseding thread cannot publish its sink
                                // between our check and our append.
                                let guard = lock_recover(&sink_slot);
                                if generation.load(Ordering::SeqCst) != my_gen {
                                    Err("superseded".to_string())
                                } else {
                                    match guard.as_ref() {
                                        Some(sink) => {
                                            sink.append(decoder);
                                            Ok(())
                                        }
                                        None => Err("sink gone".to_string()),
                                    }
                                }
                            }
                            Err(e) => Err(format!("rodio decode failed: {e}")),
                        }
                    }
                    Err(e) => Err(e),
                };

                match appended {
                    Ok(()) => {
                        any_chunk_played = true;
                        // As this chunk STARTS playing, tell the renderer which
                        // SOURCE block it covers so the spoken line highlights +
                        // scroll-follows. Only with a messageId (the play button)
                        // and while this thread is still the current generation.
                        if let (Some(mid), Some((src_start, src_end))) =
                            (message_id.as_ref(), chunk_specs[i].1)
                        {
                            if generation.load(Ordering::SeqCst) == my_gen {
                                emit_tts_chunk(mid, i, chunk_specs.len(), src_start, src_end);
                            }
                        }
                        // Drain chunk `i` while synthesizing chunk `i+1` in
                        // parallel, so the next audio is ready the moment this
                        // one finishes.
                        let prefetch = async {
                            if i + 1 < chunk_specs.len() {
                                Some(synthesize_chunk(&chunk_specs[i + 1].0, &config, i + 1).await)
                            } else {
                                None
                            }
                        };
                        let (drained, next) = tokio::join!(
                            wait_for_sink_to_drain(&sink_slot, &is_active, &generation, my_gen),
                            prefetch
                        );
                        if !drained {
                            stopped_mid_read = true;
                            break;
                        }
                        pending = next;
                    }
                    Err(err) => {
                        if err == "superseded" || err == "sink gone" {
                            // A stop/new-speak took over — exit quietly.
                            break;
                        }
                        if any_chunk_played {
                            log::warn!(
                                "[tts] chunk {i}: {err} — stopping to keep voice consistent"
                            );
                            stopped_mid_read = true;
                            break;
                        } else {
                            log::warn!(
                                "[tts] chunk {i}: {err} before any audio — falling back to say"
                            );
                            tts_failed_before_audio = true;
                            fallback_error = Some(err);
                            break;
                        }
                    }
                }
            }

            if any_chunk_played {
                let drained =
                    wait_for_sink_to_drain(&sink_slot, &is_active, &generation, my_gen).await;
                playback_completed =
                    drained && !stopped_mid_read && generation.load(Ordering::SeqCst) == my_gen;
                if stopped_mid_read {
                    log::warn!("[tts] stopped before completion to keep voice consistent");
                } else {
                    log::info!("[tts] playback complete");
                }
            }
        });

        // Fall back to macOS `say` only if cloud TTS failed before ANY audio
        // played. `run_say_fallback` itself re-checks the generation, so a
        // superseded thread never speaks the stale text.
        if tts_failed_before_audio {
            playback_completed = run_say_fallback(
                &text,
                speed,
                message_id.as_deref(),
                fallback_error.as_deref(),
                &is_active,
                &is_pending,
                &sink_slot,
                &generation,
                my_gen,
            );
        }

        completion.completed = playback_completed;

        // Release our sink + flags if we're still current — under the lock, and
        // re-checked inside it (a superseding speak/stop already owns the state).
        let mut guard = lock_recover(&sink_slot);
        if generation.load(Ordering::SeqCst) == my_gen {
            is_active.store(false, Ordering::SeqCst);
            is_pending.store(false, Ordering::SeqCst);
            is_paused.store(false, Ordering::SeqCst);
            let _ = guard.take();
        }
        // DockGuard drops here → emits idle iff still current.
    });
}

/// Speak `text` via the macOS `say` fallback, holding `is_active` for its
/// duration (so Ctrl+Shift+S/Escape route to `stop`) and polling the generation
/// so a stop / new speak kills it mid-utterance. No-op if already superseded.
fn run_say_fallback(
    text: &str,
    speed: f32,
    message_id: Option<&str>,
    error: Option<&str>,
    is_active: &Arc<AtomicBool>,
    is_pending: &Arc<AtomicBool>,
    sink_slot: &Arc<Mutex<Option<rodio::Sink>>>,
    generation: &Arc<AtomicU64>,
    my_gen: u64,
) -> bool {
    // Raise is_active UNDER the sink lock with an in-lock gen re-check, mirroring
    // the cloud publish path — so a concurrent stop()/new-speak that already
    // bumped the generation is observed here and we neither speak nor re-raise
    // is_active over the top of it.
    {
        let _guard = lock_recover(sink_slot);
        if generation.load(Ordering::SeqCst) != my_gen {
            return false;
        }
        is_active.store(true, Ordering::SeqCst);
        is_pending.store(false, Ordering::SeqCst);
        // Publish before say starts, while this generation still owns playback.
        emit_tts_state_payload(super::edge_voice_error::say_fallback_state(
            message_id, error,
        ));
    }
    log::warn!("[tts] no audio played; falling back to macOS say");
    let completed = super::native_say::speak_with_say_cancellable(text, speed, &|| {
        generation.load(Ordering::SeqCst) != my_gen
    });
    // Clear is_active only if still current — under the lock, so a concurrent
    // stop that already cleared it isn't clobbered.
    let _guard = lock_recover(sink_slot);
    if generation.load(Ordering::SeqCst) == my_gen {
        is_active.store(false, Ordering::SeqCst);
    }
    completed && generation.load(Ordering::SeqCst) == my_gen
}

/// Synthesize one chunk → MP3 bytes, with a timeout + one retry before giving up.
async fn synthesize_chunk(
    chunk: &str,
    config: &TtsConfig,
    index: usize,
) -> Result<Vec<u8>, String> {
    let mut last_error = String::new();
    for attempt in 0..=CHUNK_RETRIES {
        match timeout(
            Duration::from_secs(CHUNK_TIMEOUT_SECS),
            super::speak(chunk, config),
        )
        .await
        {
            Ok(Ok(bytes)) => return Ok(bytes),
            Ok(Err(e)) => last_error = format!("synth failed: {e}"),
            Err(_) => last_error = format!("timed out after {CHUNK_TIMEOUT_SECS}s"),
        }
        if attempt < CHUNK_RETRIES {
            log::warn!("[tts] chunk {index}: {last_error}; retrying once");
        }
    }
    Err(last_error)
}

/// Wait for the sink to drain — pause-aware (a paused sink is never empty so we
/// keep waiting) and stop/supersede-aware (bails the moment is_active clears or
/// the generation moves on).
async fn wait_for_sink_to_drain(
    sink_slot: &Arc<Mutex<Option<rodio::Sink>>>,
    is_active: &Arc<AtomicBool>,
    generation: &Arc<AtomicU64>,
    my_gen: u64,
) -> bool {
    loop {
        if !is_active.load(Ordering::SeqCst) || generation.load(Ordering::SeqCst) != my_gen {
            return false;
        }
        let empty = {
            let guard = lock_recover(sink_slot);
            guard.as_ref().map(|s| s.empty()).unwrap_or(true)
        };
        if empty {
            return true;
        }
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

/// Emit `o8:tts-state` so the dock / Ask panel can render a play/stop control.
/// Direct `emit_to(DOCK_LABEL)` (the reliable path) + broadcast to `main`.
fn emit_tts_state(state: &str) {
    emit_tts_state_payload(serde_json::json!({ "state": state }));
}

fn emit_tts_state_payload(payload: serde_json::Value) {
    use tauri::Emitter;
    if let Some(app) = super::app_handle() {
        let _ = app.emit_to(
            crate::dock_window::DOCK_LABEL,
            "o8:tts-state",
            payload.clone(),
        );
        let _ = app.emit("o8:tts-state", payload);
    }
}

/// Emit `o8:tts-chunk` as a chunk starts playing, so the message renderer can
/// highlight the SOURCE block being spoken and scroll it into view. Broadcast to
/// `main` only (the dock never renders message bodies). Mirrors `emit_tts_state`
/// but carries the block span instead of a state string.
fn emit_tts_chunk(
    message_id: &str,
    chunk_index: usize,
    chunk_count: usize,
    src_start: usize,
    src_end: usize,
) {
    use tauri::Emitter;
    if let Some(app) = super::app_handle() {
        let payload = serde_json::json!({
            "messageId": message_id,
            "chunkIndex": chunk_index,
            "chunkCount": chunk_count,
            "srcStart": src_start,
            "srcEnd": src_end,
        });
        let _ = app.emit("o8:tts-chunk", payload);
    }
}

fn provider_label(config: &TtsConfig) -> &'static str {
    match config.provider {
        super::TtsProvider::ElevenLabs => "ElevenLabs",
        super::TtsProvider::Google => "Google",
        super::TtsProvider::EdgeFree => "Steffan (free)",
    }
}

// ── Chunking (ported from aqua reading.rs) ──────────────────────────────────

/// Returns the largest byte index ≤ `cap` on a UTF-8 char boundary so slicing
/// multi-byte text (box-drawing, emoji, CJK) cannot panic.
fn safe_boundary(text: &str, cap: usize) -> usize {
    if cap >= text.len() {
        return text.len();
    }
    let mut idx = cap;
    while idx > 0 && !text.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// Builds the ordered list of TTS chunks. The FIRST chunk is short (≤200 chars
/// at a sentence boundary) so the initial round-trip returns quickly; later
/// chunks use the normal paragraph / 800-char split.
fn build_chunks(extracted: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let trimmed = extracted.trim_start();
    let (lead, remainder) = carve_lead_chunk(trimmed, LEAD_CHUNK_CHARS);
    if !lead.is_empty() {
        chunks.push(lead);
    }
    for paragraph in remainder.split("\n\n") {
        let para = paragraph.trim();
        if para.is_empty() {
            continue;
        }
        if para.len() <= MAX_CHUNK_CHARS {
            chunks.push(para.to_string());
        } else {
            chunks.extend(split_long_paragraph(para));
        }
    }
    chunks
}

/// One spoken chunk plus the byte span of its SOURCE block in the ORIGINAL
/// (pre-normalization) text — so a chunk can tell the renderer which
/// `\n\n`-delimited block to highlight while it plays. Every sub-chunk of a
/// block carries that block's span, so highlighting lands at block/paragraph
/// granularity (the only structure that survives `prepare_text_for_speech`).
struct SpokenChunk {
    text: String,
    src_start: usize,
    src_end: usize,
}

/// Like `build_chunks`, but scans the ORIGINAL text and tracks the byte span of
/// each `\n\n`-delimited block. `prepare_text_for_speech` runs PER BLOCK; blocks
/// that normalize to empty (e.g. code fences) yield no chunk, so the highlight
/// naturally skips them. The short lead chunk is carved from the FIRST spoken
/// block only, preserving first-audio latency.
fn build_chunks_with_spans(raw: &str) -> Vec<SpokenChunk> {
    let mut chunks: Vec<SpokenChunk> = Vec::new();
    let bytes = raw.as_bytes();
    let len = raw.len();
    let mut block_start = 0usize;
    let mut idx = 0usize;
    // `\n` is ASCII (0x0A) and never a UTF-8 continuation byte, so scanning the
    // raw bytes for it can't land mid-codepoint — the slices below stay valid.
    let mut lead_pending = true;

    loop {
        let at_end = idx >= len;
        let is_sep = !at_end && bytes[idx] == b'\n' && idx + 1 < len && bytes[idx + 1] == b'\n';
        if at_end || is_sep {
            append_block(
                &raw[block_start..idx],
                block_start,
                idx,
                &mut lead_pending,
                &mut chunks,
            );
            if at_end {
                break;
            }
            // Skip the whole run of newlines so a blank run doesn't emit an
            // empty block (matches `split("\n\n")`'s trim-and-skip behavior).
            idx += 2;
            while idx < len && bytes[idx] == b'\n' {
                idx += 1;
            }
            block_start = idx;
        } else {
            idx += 1;
        }
    }
    chunks
}

/// Normalize one source block for speech and push its sub-chunk(s), each tagged
/// with the block's byte span. On the first spoken block, carve the short lead
/// chunk (≤ `LEAD_CHUNK_CHARS`) so the initial round-trip returns fast.
fn append_block(
    block_raw: &str,
    src_start: usize,
    src_end: usize,
    lead_pending: &mut bool,
    out: &mut Vec<SpokenChunk>,
) {
    let spoken_owned = crate::speech_text::prepare_text_for_speech(block_raw);
    let spoken = spoken_owned.trim();
    if spoken.is_empty() {
        return;
    }

    let body: &str = if *lead_pending {
        *lead_pending = false;
        let (lead, remainder) = carve_lead_chunk(spoken, LEAD_CHUNK_CHARS);
        if !lead.is_empty() {
            out.push(SpokenChunk {
                text: lead,
                src_start,
                src_end,
            });
            remainder
        } else {
            spoken
        }
    } else {
        spoken
    };

    let body = body.trim();
    if body.is_empty() {
        return;
    }
    if body.len() <= MAX_CHUNK_CHARS {
        out.push(SpokenChunk {
            text: body.to_string(),
            src_start,
            src_end,
        });
    } else {
        for piece in split_long_paragraph(body) {
            out.push(SpokenChunk {
                text: piece,
                src_start,
                src_end,
            });
        }
    }
}

/// Takes the first sentence-ish slice (≤ `max` chars) as a short lead chunk.
/// Returns `(lead, rest)`. If the text is already shorter than `max`, returns it
/// whole as the lead and an empty rest.
fn carve_lead_chunk(text: &str, max: usize) -> (String, &str) {
    if text.len() <= max {
        return (text.to_string(), "");
    }
    let cap = safe_boundary(text, max);
    let slice = &text[..cap];
    let split = slice
        .rfind(". ")
        .or_else(|| slice.rfind("! "))
        .or_else(|| slice.rfind("? "))
        .or_else(|| slice.rfind(": "))
        .or_else(|| slice.rfind(", "))
        .or_else(|| slice.rfind(' '));
    match split {
        Some(pos) => {
            let end = pos + 1;
            (text[..end].trim().to_string(), text[end..].trim_start())
        }
        None => (String::new(), text),
    }
}

/// Splits a paragraph longer than `MAX_CHUNK_CHARS` at sentence boundaries,
/// falling back to the last space, then to a hard cut at a safe boundary.
fn split_long_paragraph(text: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = text;
    while remaining.len() > MAX_CHUNK_CHARS {
        let cap = safe_boundary(remaining, MAX_CHUNK_CHARS);
        let slice = &remaining[..cap];
        let split_pos = slice
            .rfind(". ")
            .or_else(|| slice.rfind("! "))
            .or_else(|| slice.rfind("? "))
            .or_else(|| slice.rfind(' '));
        match split_pos {
            Some(pos) => {
                let end = pos + 1;
                chunks.push(remaining[..end].trim().to_string());
                remaining = remaining[end..].trim_start();
            }
            None => {
                chunks.push(remaining[..cap].trim().to_string());
                remaining = remaining[cap..].trim_start();
            }
        }
    }
    if !remaining.is_empty() {
        chunks.push(remaining.trim().to_string());
    }
    chunks
}

#[cfg(test)]
mod completion_tests {
    use super::*;

    #[tokio::test]
    async fn empty_governed_utterance_fails_closed() {
        let config = TtsConfig {
            provider: super::super::TtsProvider::EdgeFree,
            voice_id: "test".to_string(),
            speed: 1.0,
            pitch: 0.0,
        };
        let completed = play_thread_with_completion("   ".to_string(), config)
            .await
            .expect("completion sender");

        assert!(!completed);
    }
}
