//! whisper.cpp transcription (feature `whisper`), via `whisper-rs`.

use crate::daemon::Transcriber;
use crate::model::{self, Downloader, ModelChoice};
use crate::protocol::Event;
use std::path::PathBuf;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Lazily loads the model for the active language and keeps it resident.
pub struct WhisperTranscriber {
    requested: Option<String>,
    model_dir: PathBuf,
    downloader: Box<dyn Downloader + Send>,
    threads: i32,
    loaded: Option<(ModelChoice, WhisperContext)>,
}

impl WhisperTranscriber {
    /// `requested` is a model name or path (`O8_WHISPER_MODEL`); `None` picks
    /// the language default.
    pub fn new(
        requested: Option<String>,
        model_dir: PathBuf,
        downloader: Box<dyn Downloader + Send>,
    ) -> Self {
        whisper_rs::install_logging_hooks();
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8) as i32)
            .unwrap_or(4);
        Self {
            requested,
            model_dir,
            downloader,
            threads,
            loaded: None,
        }
    }

    fn context(
        &mut self,
        language: Option<&str>,
        notify: &dyn Fn(Event),
    ) -> Result<&WhisperContext, String> {
        let choice = model::choose(self.requested.as_deref(), language)?;
        if self.loaded.as_ref().map(|(c, _)| c) != Some(&choice) {
            let path = model::ensure(
                &choice,
                &self.model_dir,
                self.downloader.as_ref(),
                &|spec| {
                    notify(Event::status(
                        format!("model_downloading:{}", spec.name),
                        None,
                    ))
                },
            )?;
            let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                .map_err(|e| {
                format!("model_unavailable: failed to load {}: {e}", path.display())
            })?;
            notify(Event::status(
                format!("model_ready:{}", path.display()),
                None,
            ));
            self.loaded = Some((choice, ctx));
        }
        Ok(&self.loaded.as_ref().expect("model loaded above").1)
    }
}

impl Transcriber for WhisperTranscriber {
    fn prepare(&mut self, language: Option<&str>, notify: &dyn Fn(Event)) -> Result<(), String> {
        self.context(language, notify).map(|_| ())
    }

    fn transcribe(
        &mut self,
        samples: &[f32],
        language: Option<&str>,
        notify: &dyn Fn(Event),
    ) -> Result<String, String> {
        // whisper.cpp needs at least ~1 s of input; pad short clips with silence.
        let min = crate::audio::SAMPLE_RATE as usize + crate::audio::SAMPLE_RATE as usize / 10;
        let mut padded;
        let input = if samples.len() < min {
            padded = samples.to_vec();
            padded.resize(min, 0.0);
            &padded[..]
        } else {
            samples
        };
        let threads = self.threads;
        let ctx = self.context(language, notify)?;
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("whisper state: {e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(threads);
        params.set_language(Some(language.unwrap_or("auto")));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state
            .full(params, input)
            .map_err(|e| format!("whisper transcription failed: {e}"))?;
        let text = state
            .as_iter()
            .filter_map(|segment| segment.to_str_lossy().ok().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty() && !is_non_speech_marker(s))
            .collect::<Vec<_>>()
            .join(" ");
        Ok(text)
    }
}

/// whisper.cpp marks silence and noise with bracketed tags such as
/// `[BLANK_AUDIO]` or `(wind blowing)`; they are not dictation.
pub fn is_non_speech_marker(segment: &str) -> bool {
    let s = segment.trim();
    (s.starts_with('[') && s.ends_with(']')) || (s.starts_with('(') && s.ends_with(')'))
}

#[cfg(test)]
mod tests {
    use super::is_non_speech_marker;

    #[test]
    fn drops_whisper_non_speech_markers() {
        assert!(is_non_speech_marker("[BLANK_AUDIO]"));
        assert!(is_non_speech_marker(" (keyboard clicking) "));
        assert!(!is_non_speech_marker("Hello [world]."));
    }
}
