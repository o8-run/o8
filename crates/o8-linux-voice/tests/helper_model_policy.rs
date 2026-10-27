//! Exercise the shipped helper's argument parsing, startup and model loader.
#![cfg(all(feature = "whisper", target_os = "linux"))]

use o8_linux_voice::protocol::{parse_event, Event};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

struct Fixture(PathBuf);
impl Fixture {
    fn new(label: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("o8-helper-policy-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let curl = root.join("curl");
        std::fs::write(
            &curl,
            b"#!/bin/sh\nprintf called > \"$O8_TEST_DOWNLOAD_MARKER\"\nexit 97\n",
        )
        .unwrap();
        std::fs::set_permissions(curl, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_o8-speech-recognizer"));
        command
            .args(args)
            .arg("--model-dir")
            .arg(self.0.join("models"))
            .env("PATH", &self.0)
            .env_remove("O8_WHISPER_MODEL")
            .env("O8_TEST_DOWNLOAD_MARKER", self.0.join("network-called"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, args: &[&str], input: &[u8]) -> Output {
        let mut child = self.command(args).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("helper did not exit");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child.wait_with_output().unwrap()
    }
}

struct Helper(Child);
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn helper_declined_model_keeps_capture_disabled() {
    let fixture = Fixture::new("declined");
    let audio = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/quick-brown-fox.wav"
    );
    let mut helper = Helper(
        fixture
            .command(&["--audio-file", audio, "--no-partials"])
            .env("TMPDIR", &fixture.0)
            .spawn()
            .unwrap(),
    );
    let mut stdin = helper.0.stdin.take().unwrap();
    let stdout = helper.0.stdout.take().unwrap();
    let (tx, rx) = channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            tx.send(parse_event(&line).expect("helper protocol event"))
                .unwrap();
        }
    });
    let mut events = Vec::new();
    let until = |events: &mut Vec<Event>, predicate: &dyn Fn(&Event) -> bool| loop {
        let event = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("helper response");
        let done = predicate(&event);
        events.push(event);
        if done {
            break;
        }
    };
    until(&mut events, &|e| {
        e.kind == "error" && e.text.contains("approval")
    });
    for id in [41, 42] {
        if id == 42 {
            writeln!(stdin, "locale:fr-FR").unwrap();
            until(&mut events, &|e| {
                e.kind == "error" && e.text.contains("approval")
            });
        }
        writeln!(stdin, "start:{id}").unwrap();
        until(&mut events, &|e| e.session_id == Some(id));
        writeln!(stdin, "stop:{id}").unwrap();
        until(&mut events, &|e| {
            e.kind == "complete" && e.session_id == Some(id)
        });
    }
    writeln!(stdin, "quit").unwrap();
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(20);
    while helper.0.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "helper did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(helper.0.wait().unwrap().success());
    reader.join().unwrap();
    events.extend(rx.try_iter());
    assert!(!fixture.0.join("network-called").exists());
    assert!(!fixture.0.join("models").exists());

    // Check events and disk: an audio-only session must not be finalized either.
    let recordings: Vec<_> = std::fs::read_dir(&fixture.0)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    assert!(
        recordings.is_empty()
            && !events.iter().any(|e| e.text == "listening"
                || matches!(
                    e.kind.as_str(),
                    "level" | "partial" | "final" | "audio_file"
                )),
        "declining the model must leave capture off: recordings={recordings:?}, events={events:#?}"
    );
    for id in [41, 42] {
        assert!(
            events.iter().any(|e| e.kind == "error"
                && e.session_id == Some(id)
                && e.text.contains("Voice is off")
                && e.text.contains("approval")
                && e.text.contains("--download-model")),
            "start must explain the required approval: {events:#?}"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn helper_startup_and_locale_never_fetch_models() {
    let fixture = Fixture::new("boot");
    let result = fixture.run(&[], b"locale:fr-FR\nquit\n");
    assert!(result.status.success(), "{result:?}");
    assert!(!fixture.0.join("network-called").exists());
    assert!(!fixture.0.join("models").exists());
    let output = String::from_utf8(result.stdout).unwrap();
    assert!(output.contains("147964211 bytes"), "{output}");
    assert!(output.contains("147951465 bytes"), "{output}");
    assert!(output.contains("--download-model"), "{output}");
}

#[test]
fn helper_install_discloses_size_and_requires_matching_approval() {
    let fixture = Fixture::new("approval");
    for args in [
        vec!["--download-model", "base.en"],
        vec!["--download-model", "base.en", "--accept-model-size", "1"],
    ] {
        let result = fixture.run(&args, b"");
        assert_eq!(result.status.code(), Some(2));
        let message = String::from_utf8(result.stderr).unwrap();
        assert!(message.contains("147964211 bytes (148.0 MB)"), "{message}");
        assert!(
            message.contains("--accept-model-size 147964211"),
            "{message}"
        );
        assert!(!fixture.0.join("network-called").exists());
        assert!(!fixture.0.join("models").exists());
    }
    let result = fixture.run(
        &[
            "--download-model",
            "base.en",
            "--accept-model-size",
            "147964211",
        ],
        b"",
    );
    assert_eq!(result.status.code(), Some(2)); // The test downloader deliberately refuses.
    assert!(
        fixture.0.join("network-called").exists(),
        "explicit approval reaches the downloader"
    );
}

#[test]
fn helper_rejects_same_size_corrupt_cache_without_fetch() {
    let fixture = Fixture::new("corrupt");
    let models = fixture.0.join("models");
    std::fs::create_dir(&models).unwrap();
    // Sparse file: exercises the pinned catalog size without a model download.
    std::fs::File::create(models.join("ggml-base.en.bin"))
        .unwrap()
        .set_len(147_964_211)
        .unwrap();
    let result = fixture.run(&["--model", "base.en"], b"quit\n");
    assert!(result.status.success(), "{result:?}");
    assert!(!fixture.0.join("network-called").exists());
    let output = String::from_utf8(result.stdout).unwrap();
    assert!(output.contains("checksum mismatch"), "{output}");
}
