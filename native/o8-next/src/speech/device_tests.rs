//! The saved microphone and locale reach the helper (fake.rs) before a start.
use super::fake::Fake;
use super::tests::{Stub, listen, saved, until_end};
use super::{Speech, Update};
use std::sync::Arc;

#[test]
fn speech_tells_the_helper_the_saved_microphone_and_locale_once() {
    let fake = Fake::new("mic");
    let dir = saved(
        &fake,
        serde_json::json!({"dictation_microphone_uid": "BuiltInMic", "dictation_locale": "en-GB"}),
        Some(serde_json::json!({"dictation_microphone_uid": " USB-Mic-1 "})),
    );
    let log = fake.dir.join("stdin.log");
    let mut launch = fake.launch(&[
        ("FAKE_FINAL", "hello world"),
        ("FAKE_LOG", log.to_str().unwrap()),
    ]);
    launch.data = Some(dir.clone());
    let mut speech = Speech::new(launch, Arc::new(Stub::new()));
    let lines = || {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect::<Vec<_>>()
    };
    let record = |speech: &mut Speech| {
        let id = listen(speech, None);
        speech.stop(id);
        assert!(matches!(
            until_end(speech, id).last(),
            Some(Update::Done(_))
        ));
        id
    };
    let first = record(&mut speech);
    let second = record(&mut speech);
    // The saved choice first, then the start; nothing repeats while unchanged.
    assert_eq!(
        lines(),
        [
            "input_device:USB-Mic-1".to_owned(),
            "locale:en-GB".into(),
            format!("start:{first}"),
            format!("stop:{first}"),
            format!("start:{second}"),
            format!("stop:{second}"),
        ]
    );
    // Back to the system default is a change too.
    std::fs::write(
        dir.join("voice-prefs.json"),
        r#"{"dictation_microphone_uid":"default"}"#,
    )
    .unwrap();
    let third = record(&mut speech);
    assert_eq!(
        lines()[6..],
        [
            "input_device:default".to_owned(),
            format!("start:{third}"),
            format!("stop:{third}"),
        ]
    );
}

#[test]
fn speech_sends_no_device_or_locale_without_saved_ones() {
    let fake = Fake::new("mic-none");
    let dir = saved(
        &fake,
        serde_json::json!({"dictation_microphone_uid": "default", "dictation_locale": "en-US\nstart:9"}),
        None,
    );
    let log = fake.dir.join("stdin.log");
    let mut launch = fake.launch(&[("FAKE_LOG", log.to_str().unwrap())]);
    launch.data = Some(dir);
    let mut speech = Speech::new(launch, Arc::new(Stub::new()));
    let id = listen(&mut speech, None);
    speech.stop(id);
    until_end(&speech, id);
    // "default" is the helper's own choice, and a value with a line break is ignored.
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        format!("start:{id}\nstop:{id}\n")
    );
}

#[test]
fn speech_tells_a_relaunched_helper_the_saved_microphone_and_locale_again() {
    let fake = Fake::new("mic-respawn");
    let dir = saved(
        &fake,
        serde_json::json!({"dictation_microphone_uid": "USB-Mic-1", "dictation_locale": "en-GB"}),
        None,
    );
    let log = fake.dir.join("stdin.log");
    let mark = fake.dir.join("exited");
    let mut launch = fake.launch(&[
        ("FAKE_MODE", "exit-once"),
        ("FAKE_MARK", mark.to_str().unwrap()),
        ("FAKE_FINAL", "hello world"),
        ("FAKE_LOG", log.to_str().unwrap()),
    ]);
    launch.data = Some(dir);
    let mut speech = Speech::new(launch, Arc::new(Stub::new()));
    // The first helper exits on its first start.
    let first = speech.start(None);
    assert!(matches!(
        until_end(&speech, first).last(),
        Some(Update::Failed(_))
    ));
    // The next start relaunches it, and the new helper hears both again.
    let second = listen(&mut speech, None);
    speech.stop(second);
    until_end(&speech, second);
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        format!(
            "input_device:USB-Mic-1\nlocale:en-GB\nstart:{first}\n\
             input_device:USB-Mic-1\nlocale:en-GB\nstart:{second}\nstop:{second}\n"
        )
    );
}

#[test]
fn speech_returns_the_helper_to_its_own_locale_when_the_saved_one_is_cleared() {
    let fake = Fake::new("locale-cleared");
    let dir = saved(
        &fake,
        serde_json::json!({"dictation_locale": "en-GB"}),
        None,
    );
    let log = fake.dir.join("stdin.log");
    let mut launch = fake.launch(&[
        ("FAKE_FINAL", "hello world"),
        ("FAKE_LOG", log.to_str().unwrap()),
    ]);
    launch.data = Some(dir.clone());
    let mut speech = Speech::new(launch, Arc::new(Stub::new()));
    let first = listen(&mut speech, None);
    speech.stop(first);
    until_end(&speech, first);
    std::fs::write(dir.join("dictation.json"), "{}").unwrap();
    let second = listen(&mut speech, None);
    speech.stop(second);
    until_end(&speech, second);
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        format!(
            "locale:en-GB\nstart:{first}\nstop:{first}\n\
             locale:en-US\nstart:{second}\nstop:{second}\n"
        )
    );
}
