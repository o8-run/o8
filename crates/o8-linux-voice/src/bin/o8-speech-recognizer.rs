//! `o8-speech-recognizer`: the Linux counterpart of the macOS
//! `speech_recognizer` helper. It speaks the same stdin/stdout protocol (see
//! `o8_linux_voice::protocol`) and transcribes locally with whisper.cpp.
//!
//! Usage:
//!   o8-speech-recognizer [--audio-fifo PATH | --audio-file WAV]
//!                        [--model NAME|PATH] [--model-dir DIR] [--no-partials]
//!   o8-speech-recognizer --input-devices-json
//!   o8-speech-recognizer --download-model NAME [--accept-model-size BYTES]
//!
//! Environment: `O8_WHISPER_MODEL` (model name or path), `O8_DATA_DIR`.

use o8_linux_voice::capture::{AudioSource, FifoSource, RecorderSource, WavFileSource};
use o8_linux_voice::daemon::{self, DaemonOptions};
use o8_linux_voice::model::{self, CommandDownloader};
use o8_linux_voice::whisper::WhisperTranscriber;
use o8_linux_voice::{devices, tools};
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut fifo: Option<PathBuf> = None;
    let mut file: Option<PathBuf> = None;
    let mut requested_model = std::env::var("O8_WHISPER_MODEL")
        .ok()
        .filter(|s| !s.is_empty());
    let mut model_dir = model::default_model_dir();
    let mut download_model = None;
    let mut accepted_size = None;
    let mut options = DaemonOptions::default();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--audio-fifo" => fifo = args.next().map(PathBuf::from),
            "--audio-file" => file = args.next().map(PathBuf::from),
            "--model" => requested_model = args.next(),
            "--model-dir" => model_dir = args.next().map(PathBuf::from).unwrap_or(model_dir),
            "--download-model" => download_model = Some(args.next().unwrap_or_default()),
            "--accept-model-size" => accepted_size = Some(args.next().unwrap_or_default()),
            "--no-partials" => options.partial_interval = None,
            "--input-devices-json" => {
                println!("{}", devices::input_devices_json(&tools::system_path()));
                return;
            }
            "--help" | "-h" => {
                eprintln!("usage: o8-speech-recognizer [--audio-fifo PATH | --audio-file WAV] [--model NAME|PATH] [--model-dir DIR] [--no-partials] | --input-devices-json | --download-model NAME [--model-dir DIR] [--accept-model-size BYTES]");
                return;
            }
            other => eprintln!("o8-speech-recognizer: ignoring unknown argument {other}"),
        }
    }

    if let Some(name) = download_model {
        let Some(spec) = model::spec(&name) else {
            eprintln!("Unknown model: {name}");
            std::process::exit(2);
        };
        eprintln!(
            "Model {}: {} bytes ({:.1} MB)",
            spec.name,
            spec.size,
            spec.size as f64 / 1_000_000.0
        );
        if accepted_size.as_deref().and_then(|s| s.parse::<u64>().ok()) != Some(spec.size) {
            eprintln!("No download started. To approve this size, repeat this command with --accept-model-size {}.", spec.size);
            std::process::exit(2);
        }
        let downloader = CommandDownloader {
            search_path: tools::system_path(),
        };
        let approved = model::ApprovedDownload {
            downloader: &downloader,
            size: spec.size,
        };
        match model::ensure(
            &model::ModelChoice::Managed(spec),
            &model_dir,
            &approved,
            &|_| {},
        ) {
            Ok(path) => eprintln!("Model ready: {}", path.display()),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if accepted_size.is_some() {
        eprintln!("--accept-model-size requires --download-model NAME");
        std::process::exit(2);
    }

    let source: Box<dyn AudioSource> = if let Some(path) = file {
        match WavFileSource::open(&path) {
            Ok(source) => Box::new(source),
            Err(e) => {
                eprintln!("o8-speech-recognizer: {e}");
                std::process::exit(2);
            }
        }
    } else if let Some(path) = fifo {
        Box::new(FifoSource::new(path))
    } else {
        Box::new(RecorderSource::new(tools::system_path()))
    };

    let transcriber = WhisperTranscriber::new(
        requested_model,
        model_dir,
        Box::new(CommandDownloader {
            search_path: tools::system_path(),
        }),
    );
    let stdin = std::io::BufReader::new(std::io::stdin());
    daemon::run(
        stdin,
        std::io::stdout(),
        source,
        Box::new(transcriber),
        options,
    );
}
