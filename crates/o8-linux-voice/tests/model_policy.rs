//! Model policy through the same daemon and loader entry points as dictation.
use o8_linux_voice::capture::{AudioSource, FailureSink, SampleSink};
use o8_linux_voice::daemon::{self, DaemonOptions, Transcriber};
use o8_linux_voice::model::{self, Downloader, ModelChoice, ModelSpec};
use o8_linux_voice::protocol::Event;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MODEL: ModelSpec = ModelSpec {
    name: "fixture",
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
};

struct Files(PathBuf);
impl Files {
    fn new(label: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("o8-model-policy-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Default)]
struct Network(Arc<AtomicUsize>);
impl Downloader for Network {
    fn fetch(&self, _: &str, dest: &Path) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        std::fs::write(dest, b"hello").map_err(|e| e.to_string())
    }
}

#[test]
fn same_size_corrupt_cache_is_rejected_without_download() {
    let files = Files::new("corruption");
    let path = files.0.join(MODEL.file_name());
    let network = Network::default();
    let choice = ModelChoice::Managed(&MODEL);
    std::fs::write(&path, b"hello").unwrap();
    assert_eq!(
        model::ensure(&choice, &files.0, &network, &|_| {}).unwrap(),
        path
    );
    std::fs::write(&path, b"HELLO").unwrap();
    let result = model::ensure(&choice, &files.0, &network, &|_| {});
    assert!(
        result.is_err(),
        "same-size replacement must be rehashed before load"
    );
    assert!(result.unwrap_err().contains("checksum"));
    assert_eq!(network.0.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read(path).unwrap(), b"HELLO");
}

#[test]
fn corrupt_cache_is_repaired_only_with_explicit_size_approval() {
    let files = Files::new("repair");
    let path = files.0.join(MODEL.file_name());
    let network = Network::default();
    let choice = ModelChoice::Managed(&MODEL);
    std::fs::write(&path, b"HELLO").unwrap();
    let wrong_size = model::ApprovedDownload {
        downloader: &network,
        size: 4,
    };
    assert!(model::ensure(&choice, &files.0, &wrong_size, &|_| {}).is_err());
    assert_eq!(network.0.load(Ordering::SeqCst), 0);
    let approved = model::ApprovedDownload {
        downloader: &network,
        size: MODEL.size,
    };
    model::ensure(&choice, &files.0, &approved, &|_| {}).unwrap();
    assert_eq!(network.0.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read(path).unwrap(), b"hello");
}

struct Mic;
impl AudioSource for Mic {
    fn describe(&self) -> String {
        "capture:fixture".into()
    }
    fn set_input_device(&mut self, _: Option<String>) {}
    fn start(&mut self, _: SampleSink, _: FailureSink) -> Result<(), String> {
        Ok(())
    }
    fn stop(&mut self) {}
}
struct Loader {
    directory: PathBuf,
    network: Network,
}
impl Transcriber for Loader {
    fn prepare(&mut self, _: Option<&str>, _: &dyn Fn(Event)) -> Result<(), String> {
        model::ensure(
            &ModelChoice::Managed(&MODEL),
            &self.directory,
            &self.network,
            &|_| {},
        )
        .map(|_| ())
    }
    fn transcribe(
        &mut self,
        _: &[f32],
        _: Option<&str>,
        _: &dyn Fn(Event),
    ) -> Result<String, String> {
        unreachable!("this test never starts the microphone")
    }
}
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn startup_and_locale_do_not_download_models() {
    let files = Files::new("startup");
    let output = Output::default();
    let network = Network::default();
    daemon::run(
        Cursor::new(b"locale:fr-FR\nquit\n"),
        output.clone(),
        Box::new(Mic),
        Box::new(Loader {
            directory: files.0.clone(),
            network: network.clone(),
        }),
        DaemonOptions {
            wav_dir: files.0.clone(),
            ..Default::default()
        },
    );
    assert_eq!(
        network.0.load(Ordering::SeqCst),
        0,
        "boot and locale changes are not download approval"
    );
    assert!(!files.0.join(MODEL.file_name()).exists());
    let raw = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    let events: Vec<Event> = raw
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let errors: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "error")
        .collect();
    assert_eq!(errors.len(), 2);
    assert!(
        errors
            .iter()
            .all(|event| event.text.contains("5 bytes") && event.text.contains("download")),
        "the model size and explicit action must be disclosed before any transfer: {raw}"
    );
}
