//! The engine against a fake helper (fake.rs) and a stubbed server.
use super::engine::{BUSY, ENDED_EARLY, HELPER_STOPPED, MIC_DENIED, SPEECH_DENIED};
use super::fake::Fake;
use super::helper::resolve;
use super::{Event, Finish, Launch, Phase, Polished, Speech, Update, VoicePrefs};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub(super) struct Stub {
    heard: Result<String, String>,
    polished: Option<Result<Polished, String>>,
    calls: Mutex<Vec<String>>,
}

impl Stub {
    pub(super) fn new() -> Self {
        Self {
            heard: Ok(String::new()),
            polished: None,
            calls: Mutex::default(),
        }
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl Finish for Stub {
    fn transcribe(&self, wav: &Path) -> Result<String, String> {
        // The recording still exists while it is with the server.
        let present = wav.is_file();
        self.calls
            .lock()
            .unwrap()
            .push(format!("transcribe present={present}"));
        self.heard.clone()
    }
    fn polish(
        &self,
        transcript: &str,
        repo: Option<&str>,
        prefs: &VoicePrefs,
    ) -> Result<Polished, String> {
        let mut call = format!("polish {transcript} repo={}", repo.unwrap_or("-"));
        if prefs != &VoicePrefs::default() {
            call.push_str(&format!(
                " dictionary={:?} instructions={:?}",
                prefs.dictionary, prefs.instructions
            ));
        }
        self.calls.lock().unwrap().push(call);
        self.polished.clone().unwrap_or_else(|| {
            Ok(Polished {
                text: format!("{transcript}."),
                cancelled: false,
            })
        })
    }
}

/// Longer than the engine's own 10-second final deadline, which one test waits out.
fn next(speech: &Speech) -> Event {
    let events = speech.events();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(event) = events.try_recv() {
            return event;
        }
        assert!(Instant::now() < deadline, "no speech event within 30s");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Updates for `id` until the first one that ends the recording.
pub(super) fn until_end(speech: &Speech, id: u64) -> Vec<Update> {
    let mut updates = Vec::new();
    loop {
        let event = next(speech);
        assert_eq!(event.id, id, "{event:?}");
        let end = !matches!(
            event.update,
            Update::Phase(Phase::Starting | Phase::Listening | Phase::Finishing)
                | Update::Phase(Phase::Transcribing | Phase::Polishing)
                | Update::Level(_)
                | Update::Partial(_)
        );
        updates.push(event.update);
        if end {
            return updates;
        }
    }
}

/// Starts a recording and reads through its last partial.
pub(super) fn listen(speech: &mut Speech, repo: Option<&str>) -> u64 {
    let id = speech.start(repo.map(String::from));
    let mut updates = Vec::new();
    while updates.last() != Some(&Update::Partial("hello world".into())) {
        let event = next(speech);
        assert_eq!(event.id, id, "{event:?}");
        updates.push(event.update);
    }
    assert_eq!(
        updates,
        [
            Update::Phase(Phase::Starting),
            Update::Phase(Phase::Listening),
            Update::Level(0.5),
            Update::Partial("hello".into()),
            Update::Partial("hello world".into()),
        ]
    );
    id
}

fn gone(path: &Path) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while path.exists() {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

#[test]
fn speech_apple_final_is_polished_and_the_recording_removed() {
    let fake = Fake::new("apple");
    let wav = fake.wav();
    let stub = Arc::new(Stub::new());
    let launch = fake.launch(&[
        ("FAKE_FINAL", "hello world"),
        ("FAKE_AUDIO", wav.to_str().unwrap()),
    ]);
    let mut speech = Speech::new(launch, stub.clone());
    let id = listen(&mut speech, Some("/work/repo"));
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id),
        [
            Update::Phase(Phase::Finishing),
            Update::Phase(Phase::Polishing),
            Update::Done("hello world.".into()),
        ]
    );
    assert_eq!(stub.calls(), ["polish hello world repo=/work/repo"]);
    assert!(gone(&wav));
}

#[test]
fn speech_empty_apple_final_falls_back_to_whisper() {
    let fake = Fake::new("whisper");
    let wav = fake.wav();
    let stub = Arc::new(Stub {
        heard: Ok(" from whisper ".into()),
        ..Stub::new()
    });
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_AUDIO", wav.to_str().unwrap())]),
        stub.clone(),
    );
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id),
        [
            Update::Phase(Phase::Finishing),
            Update::Phase(Phase::Transcribing),
            Update::Phase(Phase::Polishing),
            Update::Done("from whisper.".into()),
        ]
    );
    assert_eq!(
        stub.calls(),
        ["transcribe present=true", "polish from whisper repo=-"]
    );
    assert!(gone(&wav));
}

#[test]
fn speech_reports_nothing_heard_without_server_calls() {
    let fake = Fake::new("empty");
    let stub = Arc::new(Stub::new());
    let mut speech = Speech::new(fake.launch(&[]), stub.clone());
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id),
        [Update::Phase(Phase::Finishing), Update::Empty]
    );
    assert!(stub.calls().is_empty());
}

#[test]
fn speech_whisper_hearing_nothing_is_empty() {
    let fake = Fake::new("whisper-empty");
    let wav = fake.wav();
    let stub = Arc::new(Stub::new());
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_AUDIO", wav.to_str().unwrap())]),
        stub.clone(),
    );
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(until_end(&speech, id).last(), Some(&Update::Empty));
    assert_eq!(stub.calls(), ["transcribe present=true"]);
    assert!(gone(&wav));
}

#[test]
fn speech_cancel_from_polish_is_dropped() {
    let fake = Fake::new("dropped");
    let stub = Arc::new(Stub {
        polished: Some(Ok(Polished {
            text: String::new(),
            cancelled: true,
        })),
        ..Stub::new()
    });
    // The server cancels what is left after "undo" removes the last word.
    let mut speech = Speech::new(fake.launch(&[("FAKE_FINAL", "hello undo")]), stub);
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(until_end(&speech, id).last(), Some(&Update::Dropped));
}

#[test]
fn speech_spoken_cancel_is_dropped_when_polish_is_unreachable() {
    let fake = Fake::new("dropped-offline");
    let stub = Arc::new(Stub {
        polished: Some(Err("Polish could not reach the o8 server.".into())),
        ..Stub::new()
    });
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_FINAL", "Scratch that.")]),
        stub.clone(),
    );
    let id = listen(&mut speech, None);
    speech.stop(id);
    let updates = until_end(&speech, id);
    assert_eq!(updates.last(), Some(&Update::Dropped));
    assert!(!updates.contains(&Update::Phase(Phase::Polishing)));
    assert!(stub.calls().is_empty(), "{:?}", stub.calls());
}

#[test]
fn speech_knows_the_composer_cancel_phrases() {
    use super::engine::spoken_cancel;
    for text in [
        "cancel",
        "Cancel.",
        " never mind ",
        "Nevermind.",
        "Scratch that.",
        "forget it",
        "Forget that.",
    ] {
        assert!(spoken_cancel(text), "{text}");
    }
    for text in [
        "please cancel",
        "scratch that idea",
        "never",
        "Cancel the build.",
    ] {
        assert!(!spoken_cancel(text), "{text}");
    }
}

#[test]
fn speech_failed_polish_sends_the_raw_text() {
    let fake = Fake::new("raw");
    let stub = Arc::new(Stub {
        polished: Some(Err("Polish could not reach the o8 server.".into())),
        ..Stub::new()
    });
    let mut speech = Speech::new(fake.launch(&[("FAKE_FINAL", "hello world")]), stub);
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Done("hello world".into()))
    );
}

#[test]
fn speech_failed_transcription_reports_the_server_reason() {
    let fake = Fake::new("transcribe-fails");
    let wav = fake.wav();
    let stub = Arc::new(Stub {
        heard: Err("Dictation needs an OpenRouter key or an active plan to transcribe.".into()),
        ..Stub::new()
    });
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_AUDIO", wav.to_str().unwrap())]),
        stub.clone(),
    );
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Failed(
            "Dictation needs an OpenRouter key or an active plan to transcribe.".into()
        ))
    );
    assert_eq!(stub.calls(), ["transcribe present=true"]);
    assert!(gone(&wav));
}

#[test]
fn speech_cancel_discards_late_text_and_recording_then_starts_again() {
    let fake = Fake::new("cancel");
    let wav = fake.wav();
    let stub = Arc::new(Stub::new());
    let launch = fake.launch(&[
        ("FAKE_FINAL", "hello world"),
        ("FAKE_AUDIO", wav.to_str().unwrap()),
    ]);
    let mut speech = Speech::new(launch, stub.clone());
    let id = listen(&mut speech, None);
    speech.cancel(id);
    assert_eq!(until_end(&speech, id), [Update::Phase(Phase::Idle)]);
    // The helper still finalizes before it reads the next start; its WAV is
    // removed and its text ignored.
    let again = listen(&mut speech, None);
    assert_eq!(again, id + 1);
    assert!(!wav.exists());
    speech.stop(again);
    assert_eq!(
        until_end(&speech, again).last(),
        Some(&Update::Done("hello world.".into()))
    );
    assert_eq!(stub.calls(), ["polish hello world repo=-"]);
}

#[test]
fn speech_refuses_a_second_microphone_owner() {
    let fake = Fake::new("busy");
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_FINAL", "hello world")]),
        Arc::new(Stub::new()),
    );
    let id = listen(&mut speech, None);
    let second = speech.start(None);
    assert_eq!(
        next(&speech),
        Event {
            id: second,
            update: Update::Failed(BUSY.into())
        }
    );
    // The first recording is unaffected.
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Done("hello world.".into()))
    );
}

#[test]
fn speech_waits_for_the_helper_to_be_ready() {
    let fake = Fake::new("late-ready");
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_MODE", "late-ready"), ("FAKE_FINAL", "hello world")]),
        Arc::new(Stub::new()),
    );
    // listen() fails on the helper's "Audio engine not prepared." refusal.
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Done("hello world.".into()))
    );
}

#[test]
fn speech_helper_exit_fails_the_recording_and_the_next_start_relaunches() {
    let fake = Fake::new("exit-once");
    let mark = fake.dir.join("exited");
    let launch = fake.launch(&[
        ("FAKE_MODE", "exit-once"),
        ("FAKE_MARK", mark.to_str().unwrap()),
        ("FAKE_FINAL", "hello world"),
    ]);
    let mut speech = Speech::new(launch, Arc::new(Stub::new()));
    let id = speech.start(None);
    assert_eq!(
        until_end(&speech, id),
        [
            Update::Phase(Phase::Starting),
            Update::Failed(HELPER_STOPPED.into())
        ]
    );
    assert!(mark.exists());
    let again = listen(&mut speech, None);
    speech.stop(again);
    assert_eq!(
        until_end(&speech, again).last(),
        Some(&Update::Done("hello world.".into()))
    );
}

#[test]
fn speech_complete_while_listening_is_an_early_end() {
    let fake = Fake::new("early");
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_MODE", "early-complete")]),
        Arc::new(Stub::new()),
    );
    let id = listen(&mut speech, None);
    assert_eq!(until_end(&speech, id), [Update::Failed(ENDED_EARLY.into())]);
}

#[test]
fn speech_denied_microphone_fails_the_start() {
    let fake = Fake::new("mic-denied");
    let boot = r#"{"type":"status","text":"microphone:denied"}"#;
    let mut speech = Speech::new(fake.launch(&[("FAKE_BOOT", boot)]), Arc::new(Stub::new()));
    let id = speech.start(None);
    let updates = until_end(&speech, id);
    assert_eq!(updates.last(), Some(&Update::Failed(MIC_DENIED.into())));
    // A later start relaunches the helper, which asks again.
    let again = speech.start(None);
    assert_eq!(
        until_end(&speech, again).last(),
        Some(&Update::Failed(MIC_DENIED.into()))
    );
}

#[test]
fn speech_denied_recognition_explains_the_helper_exit() {
    let fake = Fake::new("speech-denied");
    let boot = r#"{"type":"status","text":"speech_recognition:denied"}"#;
    let mut speech = Speech::new(
        fake.launch(&[("FAKE_BOOT", boot), ("FAKE_MODE", "speech-denied")]),
        Arc::new(Stub::new()),
    );
    let id = speech.start(None);
    assert_eq!(
        until_end(&speech, id),
        [
            Update::Phase(Phase::Starting),
            Update::Failed(SPEECH_DENIED.into())
        ]
    );
}

#[test]
fn speech_stop_with_no_final_still_finishes() {
    let fake = Fake::new("silent-stop");
    let stub = Arc::new(Stub::new());
    let mut speech = Speech::new(fake.launch(&[("FAKE_MODE", "silent-stop")]), stub.clone());
    let id = listen(&mut speech, None);
    let stopped = Instant::now();
    speech.stop(id);
    // Nothing arrived before the final deadline: nothing to send.
    assert_eq!(
        until_end(&speech, id),
        [Update::Phase(Phase::Finishing), Update::Empty]
    );
    assert!(stopped.elapsed() >= Duration::from_secs(9));
    assert!(stub.calls().is_empty());
}

#[test]
fn speech_missing_helper_fails_the_start() {
    let mut speech = Speech::new(
        Launch {
            program: "/nonexistent/o8-speech-helper".into(),
            args: Vec::new(),
            envs: Vec::new(),
            data: None,
        },
        Arc::new(Stub::new()),
    );
    let id = speech.start(None);
    let event = next(&speech);
    assert_eq!(event.id, id);
    assert!(
        matches!(&event.update, Update::Failed(text) if text.starts_with("The speech helper could not start")),
        "{event:?}"
    );
}

#[test]
fn speech_helper_path_prefers_the_override_then_the_bundle() {
    let fake = Fake::new("path");
    let bundle = fake.dir.join("MacOS");
    std::fs::create_dir_all(&bundle).unwrap();
    let exe = bundle.join("o8-next");
    let helper = bundle.join("speech_recognizer");
    std::fs::write(&helper, "").unwrap();
    let explicit = fake.dir.join("helper.sh");
    assert_eq!(
        resolve(Some(explicit.clone()), Some(exe.clone()), None, true),
        Some(explicit)
    );
    // An override that does not exist is not silently replaced.
    assert_eq!(
        resolve(
            Some(fake.dir.join("missing")),
            Some(exe.clone()),
            None,
            true
        ),
        None
    );
    assert_eq!(resolve(None, Some(exe.clone()), None, true), Some(helper));
    assert_eq!(resolve(None, Some(exe.clone()), None, false), None);
    let source = fake.dir.join("helpers");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("speech_recognizer"), "").unwrap();
    let elsewhere = fake.dir.join("bin/o8-next");
    assert_eq!(
        resolve(None, Some(elsewhere), Some(source.clone()), true),
        Some(source.join("speech_recognizer"))
    );
}

/// A data directory with the desktop's two settings files.
pub(super) fn saved(
    fake: &Fake,
    dictation: serde_json::Value,
    overlay: Option<serde_json::Value>,
) -> PathBuf {
    let dir = fake.dir.join("data");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("dictation.json"), dictation.to_string()).unwrap();
    if let Some(overlay) = overlay {
        std::fs::write(dir.join("voice-prefs.json"), overlay.to_string()).unwrap();
    }
    dir
}

#[test]
fn speech_polish_gets_the_saved_dictionary_and_instructions_and_replacements_apply() {
    let fake = Fake::new("prefs");
    let dir = saved(
        &fake,
        serde_json::json!({
            "dictionary": ["Stale"],
            "polish_instructions": "Base instructions",
            "replacements": [{"trigger": "hello", "replacement": "Hi"}],
            "openrouter_api_key": "never sent"
        }),
        Some(serde_json::json!({
            "dictionary": [" Kubectl ", "", 3, "o8"],
            "polish_instructions": "  Write o8 in lowercase.  "
        })),
    );
    let stub = Arc::new(Stub::new());
    let mut launch = fake.launch(&[("FAKE_FINAL", "hello world")]);
    launch.data = Some(dir);
    let mut speech = Speech::new(launch, stub.clone());
    let id = listen(&mut speech, None);
    speech.stop(id);
    // voice-prefs.json wins for the keys it has; dictation.json fills the rest.
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Done("Hi world.".into()))
    );
    assert_eq!(
        stub.calls(),
        [
            r#"polish hello world repo=- dictionary=["Kubectl", "o8"] instructions="Write o8 in lowercase.""#
        ]
    );
}

#[test]
fn speech_replacements_apply_when_polish_fails() {
    let fake = Fake::new("prefs-raw");
    let dir = saved(
        &fake,
        serde_json::json!({"replacements": [
            {"trigger": "hello world", "replacement": "Greetings"},
            {"trigger": "hello", "replacement": "Hi"},
            {"trigger": "  ", "replacement": "never"}
        ]}),
        None,
    );
    let stub = Arc::new(Stub {
        polished: Some(Err("Polish could not reach the o8 server.".into())),
        ..Stub::new()
    });
    let mut launch = fake.launch(&[("FAKE_FINAL", "Hello World")]);
    launch.data = Some(dir);
    let mut speech = Speech::new(launch, stub);
    let id = listen(&mut speech, None);
    speech.stop(id);
    // Longest trigger first, matched without regard to case.
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Done("Greetings".into()))
    );
}

#[test]
fn speech_replacements_match_the_desktop_rules() {
    use super::prefs::apply_replacements;
    let rules = |pairs: &[(&str, &str)]| {
        pairs
            .iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        apply_replacements(
            "my email is my email",
            &rules(&[("MY EMAIL", "q@example.com")])
        ),
        "q@example.com is q@example.com"
    );
    assert_eq!(apply_replacements("unchanged", &[]), "unchanged");
    // Non-ASCII text whose lowercase changes length falls back to exact case.
    assert_eq!(
        apply_replacements(
            "İstanbul trip, İstanbul",
            &rules(&[("İstanbul", "Istanbul")])
        ),
        "Istanbul trip, Istanbul"
    );
}

#[test]
fn speech_prefs_read_the_desktop_data_directory() {
    use super::prefs::dir_from;
    use std::ffi::OsString;
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |key: &str| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| OsString::from(value))
        }
    };
    assert_eq!(
        dir_from(env(&[("O8_DATA_DIR", "/data"), ("HOME", "/home/q")])),
        Some(PathBuf::from("/data"))
    );
    assert_eq!(
        dir_from(env(&[("O8_DATA_DIR", ""), ("HOME", "/home/q")])),
        Some(PathBuf::from("/home/q/.o8"))
    );
    assert_eq!(dir_from(env(&[])), None);
    // A missing directory reads as no saved settings.
    assert_eq!(
        super::prefs::read(Path::new("/nonexistent/o8-speech-prefs")),
        VoicePrefs::default()
    );
}

#[test]
fn speech_appends_what_goes_out_to_voice_history() {
    let fake = Fake::new("history");
    let dir = saved(&fake, serde_json::json!({}), None);
    let path = dir.join("dictation-history.json");
    // A full file from the shell, with a field this client doesn't know.
    let old: Vec<_> = (0..200)
        .map(|n| {
            serde_json::json!({"id": n.to_string(), "ts": n, "mode": "ask",
            "text": format!("old {n}"), "app": "", "extra": n})
        })
        .collect();
    std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();
    let mut launch = fake.launch(&[("FAKE_FINAL", "hello world")]);
    launch.data = Some(dir.clone());
    let mut speech = Speech::new(launch, Arc::new(Stub::new()));
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Done("hello world.".into()))
    );
    let saved: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    // Capped at 200: the oldest went, the rest kept as they were.
    assert_eq!(saved.len(), 200);
    assert_eq!(saved[0], old[1]);
    let entry = &saved[199];
    assert_eq!(entry["mode"], "dictation");
    assert_eq!(entry["text"], "hello world.");
    assert_eq!(entry["app"], "ai.o8.desktop");
    assert!(entry["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(entry["ts"].as_i64().is_some_and(|ts| ts > 1_700_000_000));
    // Settings > Voice > History reads it, newest first.
    let listed = crate::shell::settings::voice_history::read(&path);
    assert_eq!(listed[0].text, "hello world.");
    assert_eq!(listed[0].mode, "dictation");
    // No temp file is left behind.
    let names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(
        names.iter().all(|name| !name.ends_with(".tmp")),
        "{names:?}"
    );
}

#[test]
fn speech_keeps_nothing_in_history_that_did_not_go_out() {
    let fake = Fake::new("history-none");
    let dir = saved(&fake, serde_json::json!({}), None);
    let stub = Arc::new(Stub {
        polished: Some(Ok(Polished {
            text: String::new(),
            cancelled: true,
        })),
        ..Stub::new()
    });
    let mut launch = fake.launch(&[("FAKE_FINAL", "scratch that")]);
    launch.data = Some(dir.clone());
    let mut speech = Speech::new(launch, stub);
    // A spoken cancel, then a cancelled recording.
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(until_end(&speech, id).last(), Some(&Update::Dropped));
    let id = listen(&mut speech, None);
    speech.cancel(id);
    assert_eq!(until_end(&speech, id), [Update::Phase(Phase::Idle)]);
    assert!(!dir.join("dictation-history.json").exists());
}

#[test]
fn speech_leaves_an_unreadable_history_alone() {
    let fake = Fake::new("history-bad");
    let dir = saved(&fake, serde_json::json!({}), None);
    let path = dir.join("dictation-history.json");
    std::fs::write(&path, "{not json").unwrap();
    let mut launch = fake.launch(&[("FAKE_FINAL", "hello world")]);
    launch.data = Some(dir);
    let mut speech = Speech::new(launch, Arc::new(Stub::new()));
    let id = listen(&mut speech, None);
    speech.stop(id);
    assert_eq!(
        until_end(&speech, id).last(),
        Some(&Update::Done("hello world.".into()))
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
}
