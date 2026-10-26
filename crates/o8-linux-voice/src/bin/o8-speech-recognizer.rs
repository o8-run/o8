//! `o8-speech-recognizer`: the Linux counterpart of the macOS
//! `speech_recognizer` helper. It speaks the same stdin/stdout protocol (see
//! `o8_linux_voice::protocol`) and transcribes locally with whisper.cpp.
//!
//! Usage:
//!   o8-speech-recognizer [--audio-fifo PATH | --audio-file WAV]
//!                        [--model NAME|PATH] [--model-dir DIR] [--no-partials]
//!   o8-speech-recognizer --input-devices-json
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
    let mut options = DaemonOptions::default();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--audio-fifo" => fifo = args.next().map(PathBuf::from),
            "--audio-file" => file = args.next().map(PathBuf::from),
            "--model" => requested_model = args.next(),
            "--model-dir" => model_dir = args.next().map(PathBuf::from).unwrap_or(model_dir),
            "--no-partials" => options.partial_interval = None,
            "--input-devices-json" => {
                println!("{}", devices::input_devices_json(&tools::system_path()));
                return;
            }
            "--help" | "-h" => {
                eprintln!("usage: o8-speech-recognizer [--audio-fifo PATH | --audio-file WAV] [--model NAME|PATH] [--model-dir DIR] [--no-partials] | --input-devices-json");
                return;
            }
            other => eprintln!("o8-speech-recognizer: ignoring unknown argument {other}"),
        }
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
