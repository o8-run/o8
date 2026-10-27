//! Exercise the shipped helper's argument parsing, startup and model loader.
#![cfg(all(feature = "whisper", target_os = "linux"))]

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
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

    fn run(&self, args: &[&str], input: &[u8]) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_o8-speech-recognizer"))
            .args(args)
            .arg("--model-dir")
            .arg(self.0.join("models"))
            .env("PATH", &self.0)
            .env_remove("O8_WHISPER_MODEL")
            .env("O8_TEST_DOWNLOAD_MARKER", self.0.join("network-called"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
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
