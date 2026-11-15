// Composer dictation in process (crate::speech): o8 next runs the speech
// helper itself instead of the hidden voice page. Apple's partials fill the
// composer; on stop the client takes Apple's final text, or Whisper on the
// recording when Apple heard nothing, polishes it and hands it back once.
use super::*;
use crate::speech::{Event, Launch, Phase, ServerFinish, Speech, Update};
use std::sync::Arc;

#[derive(Default)]
pub(super) struct Native {
    speech: Option<Speech>,
    /// A test's fake helper.
    launch: Option<Launch>,
}

/// `O8_NEXT_DICTATION=host` keeps the hidden voice page and `native` needs the
/// helper; otherwise dictation is native wherever the helper is installed.
pub(super) fn enabled(s: &mut Shell) -> bool {
    if s.features.get::<Native>().launch.is_some() {
        return true;
    }
    match std::env::var("O8_NEXT_DICTATION").as_deref() {
        Ok("host") => false,
        Ok("native") => true,
        // Tests keep the host path unless they bring a helper.
        _ => !cfg!(test) && crate::speech::helper_path().is_some(),
    }
}

impl Shell {
    #[cfg(test)]
    pub(crate) fn use_speech_helper(&mut self, launch: Launch) {
        self.features.get::<Native>().launch = Some(launch);
    }
}

/// Starts a recording with `repo` as polish context; its updates arrive
/// through `event`.
pub(super) fn start(s: &mut Shell, repo: &str, cx: &mut Context<Shell>) -> Result<u64, String> {
    if s.features.get::<Native>().speech.is_none() {
        let launch = s.features.get::<Native>().launch.clone();
        let launch = launch
            .or_else(Launch::helper)
            .ok_or("Dictation needs the o8 speech helper.")?;
        let speech = Speech::new(launch, Arc::new(ServerFinish::new(s.client.clone())));
        let events = speech.events();
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if this.update(cx, |s, cx| event_for(s, event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        s.features.get::<Native>().speech = Some(speech);
    }
    s.features
        .get::<Native>()
        .speech
        .as_mut()
        .map(|speech| speech.start(Some(repo.to_owned())))
        .ok_or_else(|| "Dictation could not start.".to_string())
}

pub(super) fn stop(s: &mut Shell, id: u64) {
    if let Some(speech) = &s.features.get::<Native>().speech {
        speech.stop(id);
    }
}

pub(super) fn cancel(s: &mut Shell, id: u64) {
    if let Some(speech) = &s.features.get::<Native>().speech {
        speech.cancel(id);
    }
}

/// One update for the recording this composer holds; others are stale.
fn event_for(s: &mut Shell, event: Event, cx: &mut Context<Shell>) {
    let (native, state, sent) = {
        let mic = s.features.get::<Mic>();
        (mic.native, mic.state, mic.sent)
    };
    if native != Some(event.id) {
        return;
    }
    match event.update {
        Update::Phase(Phase::Listening) if state == DictationState::Starting => {
            show(s, DictationState::Listening, cx);
        }
        Update::Level(level) => {
            if let Some(view) = pinned(s) {
                view.update(cx, |view, _| view.dictation_level(level));
            }
        }
        Update::Partial(text)
            if matches!(state, DictationState::Starting | DictationState::Listening) =>
        {
            if state == DictationState::Starting {
                show(s, DictationState::Listening, cx);
            }
            let joined = s.features.get::<Mic>().joined(&text);
            if let Some(view) = pinned(s) {
                view.update(cx, |view, cx| view.dictate(&joined, cx));
            }
        }
        Update::Done(text) => {
            if state == DictationState::Finishing && !sent {
                s.features.get::<Mic>().sent = true;
                let (draft, joined) = {
                    let mic = s.features.get::<Mic>();
                    (mic.draft.clone(), mic.joined(&text))
                };
                if let Some(view) = pinned(s) {
                    view.update(cx, |view, cx| view.send_dictated(&draft, &joined, cx));
                }
            }
            retire(s, cx);
        }
        Update::Empty => {
            restore(s, cx);
            retire(s, cx);
            toasts::info("Dictation heard nothing to send.", cx);
        }
        Update::Dropped => {
            restore(s, cx);
            retire(s, cx);
            toasts::info("Dictation cancelled.", cx);
        }
        Update::Failed(error) => {
            restore(s, cx);
            retire(s, cx);
            toasts::error(error, cx);
        }
        _ => {}
    }
    cx.notify();
}
