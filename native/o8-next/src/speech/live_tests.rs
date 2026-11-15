//! A live check of the in-process path on a Mac, run by hand: the installed
//! speech helper (started disclaimed), Apple's recognizer, and the running
//! local o8 server's transcribe and polish routes. Nothing plays aloud: the
//! helper's `--audio-fifo` input (the shell's main-process capture path) gets
//! speech rendered by `say`, paced in real time.
//!
//! ```sh
//! O8_SPEECH_LIVE=1 cargo test --bin o8-next speech_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! It reads the server's port and operator token from the data directory
//! (`O8_DATA_DIR` or `~/.o8`) and never prints them. Voice History and the saved
//! settings use a scratch directory, so this Mac's history is not touched.
//! `O8_SPEECH_RECOGNIZER` selects another helper build.
use super::{Event, Launch, Phase, ServerFinish, Speech, Update, VoicePrefs};
use crate::client::Client;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const HELPER: &str = "/Applications/o8.app/Contents/MacOS/speech_recognizer";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("o8-speech-live-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn client() -> Client {
    let data = std::env::var_os("O8_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap()).join(".o8"));
    let read = |name: &str| {
        std::fs::read_to_string(data.join(name))
            .unwrap()
            .trim()
            .to_owned()
    };
    Client::authenticated(
        &format!("http://127.0.0.1:{}", read("api-port")),
        Some(read("ws-token")),
    )
    .unwrap()
}

/// `say` rendered to 16 kHz mono: little-endian f32 samples, and a 16-bit WAV.
fn render(dir: &Path, phrase: &str) -> (Vec<f32>, PathBuf) {
    let aiff = dir.join("phrase.aiff");
    let float = dir.join("phrase-f32.wav");
    let wav = dir.join("phrase.wav");
    let run = |program: &str, args: &[&std::ffi::OsStr]| {
        let status = std::process::Command::new(program)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "{program} failed");
    };
    run("say", &["-o".as_ref(), aiff.as_os_str(), phrase.as_ref()]);
    for (out, format) in [(&float, "LEF32@16000"), (&wav, "LEI16@16000")] {
        run(
            "afconvert",
            &[
                "-f".as_ref(),
                "WAVE".as_ref(),
                "-d".as_ref(),
                format.as_ref(),
                "-c".as_ref(),
                "1".as_ref(),
                aiff.as_os_str(),
                out.as_os_str(),
            ],
        );
    }
    let bytes = std::fs::read(&float).unwrap();
    // Walk the RIFF chunks to the data chunk.
    let mut at = 12;
    let data = loop {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            break &bytes[at + 8..at + 8 + size];
        }
        at += 8 + size + (size & 1);
    };
    let samples = data
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
        .collect();
    (samples, wav)
}

/// Feeds `samples`, then a second of silence, into the helper's FIFO at the
/// rate a microphone would deliver them.
fn feed(fifo: &Path, samples: &[f32]) {
    let mut pipe = std::fs::OpenOptions::new().write(true).open(fifo).unwrap();
    let silence = vec![0.0f32; 16_000];
    let all: Vec<f32> = samples.iter().copied().chain(silence).collect();
    let started = Instant::now();
    for (index, chunk) in all.chunks(1024).enumerate() {
        let mut frame = vec![0.0f32; 1024];
        frame[..chunk.len()].copy_from_slice(chunk);
        let bytes: Vec<u8> = frame
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        pipe.write_all(&bytes).unwrap();
        let due = Duration::from_secs_f64((index + 1) as f64 * 1024.0 / 16_000.0);
        if let Some(wait) = due.checked_sub(started.elapsed()) {
            std::thread::sleep(wait);
        }
    }
}

fn next(speech: &Speech, within: Duration) -> Event {
    let events = speech.events();
    let deadline = Instant::now() + within;
    loop {
        if let Ok(event) = events.try_recv() {
            return event;
        }
        assert!(
            Instant::now() < deadline,
            "no speech event within {within:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// One recording of `phrase` through the real helper and routes; every update.
fn dictate(speech: &mut Speech, fifo: &Path, phrase: &str, dir: &Path) -> Vec<Update> {
    let (samples, _) = render(dir, phrase);
    let id = speech.start(None);
    let mut updates = Vec::new();
    loop {
        let event = next(speech, Duration::from_secs(30));
        assert_eq!(event.id, id);
        let listening = event.update == Update::Phase(Phase::Listening);
        updates.push(event.update);
        if listening {
            break;
        }
        assert!(
            matches!(updates.last(), Some(Update::Phase(Phase::Starting))),
            "{updates:?}"
        );
    }
    feed(fifo, &samples);
    speech.stop(id);
    loop {
        let event = next(speech, Duration::from_secs(120));
        assert_eq!(event.id, id);
        let end = matches!(
            event.update,
            Update::Done(_) | Update::Empty | Update::Dropped | Update::Failed(_)
        );
        updates.push(event.update);
        if end {
            return updates;
        }
    }
}

fn summary(updates: &[Update]) -> String {
    let partials = updates
        .iter()
        .filter(|update| matches!(update, Update::Partial(_)))
        .count();
    let levels = updates
        .iter()
        .filter(|update| matches!(update, Update::Level(_)))
        .count();
    let phases: Vec<_> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Phase(phase) => Some(format!("{phase:?}")),
            _ => None,
        })
        .collect();
    format!(
        "phases {phases:?}, {partials} partials, {levels} levels, last partial {:?}, end {:?}",
        updates.iter().rev().find_map(|update| match update {
            Update::Partial(text) => Some(text.as_str()),
            _ => None,
        }),
        updates.last().unwrap()
    )
}

#[test]
#[ignore = "live: needs this Mac's speech helper and a running o8 server"]
fn speech_live_helper_round_trip() {
    if std::env::var("O8_SPEECH_LIVE").as_deref() != Ok("1") {
        eprintln!("set O8_SPEECH_LIVE=1 to run");
        return;
    }
    let dir = scratch("run");
    let fifo = dir.join("audio.fifo");
    let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let helper = std::env::var_os("O8_SPEECH_RECOGNIZER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(HELPER));
    let launch = Launch {
        program: helper,
        args: vec!["--audio-fifo".into(), fifo.clone().into()],
        envs: Vec::new(),
        data: Some(data.clone()),
    };
    let finish = Arc::new(ServerFinish::new(client()));
    let mut speech = Speech::new(launch, finish.clone());

    // 1. A normal dictation: Apple's text, polished by the server.
    let normal = dictate(
        &mut speech,
        &fifo,
        "Please check the build and run the tests.",
        &dir,
    );
    eprintln!("normal: {}", summary(&normal));
    assert!(
        matches!(normal.last(), Some(Update::Done(text)) if text.to_lowercase().contains("build")),
        "{normal:?}"
    );
    let history = std::fs::read_to_string(data.join("dictation-history.json")).unwrap();
    eprintln!("history: {history}");

    // 2. A spoken cancel: nothing goes out.
    let cancel = dictate(&mut speech, &fifo, "Scratch that.", &dir);
    eprintln!("spoken cancel: {}", summary(&cancel));
    assert_eq!(cancel.last(), Some(&Update::Dropped), "{cancel:?}");

    // 3. Whisper on a known recording, as the fallback sends it when Apple
    // returns nothing, then polish.
    let (_, wav) = render(&dir, "Open the settings page and turn on dark mode.");
    let heard = super::Finish::transcribe(&*finish, &wav);
    eprintln!("whisper: {heard:?}");
    let heard = heard.unwrap();
    assert!(heard.to_lowercase().contains("settings"), "{heard}");
    let polished = super::Finish::polish(&*finish, &heard, None, &VoicePrefs::default());
    eprintln!("whisper then polish: {polished:?}");
    drop(speech);
    let _ = std::fs::remove_dir_all(&dir);
}
