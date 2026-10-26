//! End-to-end tests of the `o8-speech-recognizer` binary over real pipes.
//! The transcription test needs a ggml model: set `O8_WHISPER_TEST_MODEL` to
//! a file such as `ggml-tiny.en.bin`; it is skipped otherwise.
#![cfg(feature = "whisper")]

use o8_linux_voice::protocol::{parse_event, Event};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::Duration;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/quick-brown-fox.wav"
);

/// Run one start/stop session against the fixture and return every event.
fn run_session(model: &str) -> Vec<Event> {
    let model_dir = std::env::temp_dir().join(format!("o8-helper-test-{}", std::process::id()));
    let mut child = Command::new(env!("CARGO_BIN_EXE_o8-speech-recognizer"))
        .args([
            "--audio-file",
            FIXTURE,
            "--model",
            model,
            "--no-partials",
            "--model-dir",
        ])
        .arg(&model_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper");
    let mut stdin = child.stdin.take().unwrap();
    let (tx, rx) = channel();
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send(parse_event(&line).unwrap_or_else(|| panic!("bad line {line}")));
        }
    });
    let mut events = Vec::new();
    let next = |events: &mut Vec<Event>, until: &dyn Fn(&Event) -> bool| loop {
        let e = rx
            .recv_timeout(Duration::from_secs(120))
            .expect("helper went quiet");
        let done = until(&e);
        events.push(e);
        if done {
            return;
        }
    };
    next(&mut events, &|e| e.kind == "ready");
    writeln!(stdin, "start:42").unwrap();
    next(&mut events, &|e| e.text == "listening" || e.kind == "error");
    std::thread::sleep(Duration::from_millis(300));
    writeln!(stdin, "stop:42").unwrap();
    next(&mut events, &|e| e.kind == "complete");
    writeln!(stdin, "quit").unwrap();
    drop(stdin);
    assert!(child.wait().unwrap().success());
    while let Ok(e) = rx.recv_timeout(Duration::from_secs(2)) {
        events.push(e);
    }
    let _ = std::fs::remove_dir_all(model_dir);
    events
}

#[test]
fn a_missing_model_is_an_error_event_not_a_crash() {
    let events = run_session("/nonexistent/ggml-missing.bin");
    let errors: Vec<_> = events.iter().filter(|e| e.kind == "error").collect();
    assert!(
        errors
            .iter()
            .any(|e| e.text.starts_with("model_unavailable:")),
        "{events:#?}"
    );
    let complete = events
        .iter()
        .position(|e| e.kind == "complete" && e.session_id == Some(42));
    assert!(
        complete.is_some(),
        "the session still completes: {events:#?}"
    );
    assert!(events
        .iter()
        .any(|e| e.kind == "audio_file" && e.session_id == Some(42)));
}

#[test]
fn transcribes_the_fixture_with_whisper() {
    let Some(model) = std::env::var("O8_WHISPER_TEST_MODEL")
        .ok()
        .filter(|m| Path::new(m).is_file())
    else {
        eprintln!("skipping: set O8_WHISPER_TEST_MODEL to a ggml model file");
        return;
    };
    let events = run_session(&model);
    let kinds: Vec<_> = events
        .iter()
        .filter(|e| e.session_id == Some(42) && e.kind != "level")
        .map(|e| e.kind.as_str())
        .collect();
    assert_eq!(
        kinds,
        ["status", "final", "audio_file", "complete"],
        "{events:#?}"
    );
    let text = events
        .iter()
        .find(|e| e.kind == "final")
        .unwrap()
        .text
        .to_lowercase();
    assert!(
        text.contains("quick") && text.contains("lazy dog"),
        "unexpected transcript: {text}"
    );
    assert_eq!(events.last().unwrap().kind, "ready");
}
