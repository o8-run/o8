//! Drives the protocol daemon exactly as the desktop shell drives the Swift
//! `speech_recognizer` helper: commands on stdin, JSON lines on stdout.

use o8_linux_voice::capture::{AudioSource, FailureSink, SampleSink};
use o8_linux_voice::daemon::{self, DaemonOptions, Transcriber};
use o8_linux_voice::protocol::{parse_event, Event};
use std::io::{BufReader, Read, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// stdin stand-in fed line by line from the test.
struct ChannelReader {
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            match self.rx.recv() {
                Ok(bytes) => self.pending = bytes,
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

#[derive(Clone, Default)]
struct SharedOut(Arc<Mutex<Vec<u8>>>);

impl Write for SharedOut {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl SharedOut {
    fn events(&self) -> Vec<Event> {
        let raw = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
        raw.lines()
            .map(|l| parse_event(l).unwrap_or_else(|| panic!("not a protocol line: {l}")))
            .collect()
    }
}

/// A microphone the test can speak into.
#[derive(Clone, Default)]
struct Mic {
    sink: Arc<Mutex<Option<SampleSink>>>,
    fail: Arc<Mutex<Option<FailureSink>>>,
    device: Arc<Mutex<Option<String>>>,
    refuse: Option<String>,
}

impl Mic {
    fn say(&self, samples: &[f32]) {
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink(samples);
        }
    }
}

impl AudioSource for Mic {
    fn start(&mut self, sink: SampleSink, on_failure: FailureSink) -> Result<(), String> {
        if let Some(reason) = &self.refuse {
            return Err(reason.clone());
        }
        *self.sink.lock().unwrap() = Some(sink);
        *self.fail.lock().unwrap() = Some(on_failure);
        Ok(())
    }
    fn stop(&mut self) {
        self.sink.lock().unwrap().take();
    }
    fn set_input_device(&mut self, device: Option<String>) {
        *self.device.lock().unwrap() = device;
    }
    fn describe(&self) -> String {
        "capture:test-mic".into()
    }
}

/// Transcribes by reporting how much audio it received.
struct CountingTranscriber {
    languages: Arc<Mutex<Vec<Option<String>>>>,
}

impl Transcriber for CountingTranscriber {
    fn prepare(&mut self, language: Option<&str>, notify: &dyn Fn(Event)) -> Result<(), String> {
        self.languages
            .lock()
            .unwrap()
            .push(language.map(str::to_owned));
        notify(Event::status("model_ready:fake", None));
        Ok(())
    }
    fn transcribe(
        &mut self,
        samples: &[f32],
        _language: Option<&str>,
        _notify: &dyn Fn(Event),
    ) -> Result<String, String> {
        if samples.iter().all(|s| *s == 0.0) {
            return Ok(String::new());
        }
        Ok(format!("heard {} samples", samples.len()))
    }
}

struct Harness {
    stdin: Sender<Vec<u8>>,
    out: SharedOut,
    mic: Mic,
    languages: Arc<Mutex<Vec<Option<String>>>>,
    wav_dir: std::path::PathBuf,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Harness {
    fn new(tag: &str, mic: Mic, partials: bool) -> Self {
        let wav_dir = std::env::temp_dir().join(format!("o8-daemon-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&wav_dir).unwrap();
        let (stdin, rx) = channel();
        let out = SharedOut::default();
        let languages = Arc::new(Mutex::new(Vec::new()));
        let options = DaemonOptions {
            wav_dir: wav_dir.clone(),
            partial_interval: partials.then(|| Duration::from_millis(500)),
            tick: Duration::from_millis(20),
            locale: "en-US".into(),
        };
        let (o, m, l) = (out.clone(), mic.clone(), languages.clone());
        let thread = std::thread::spawn(move || {
            let input = BufReader::new(ChannelReader {
                rx,
                pending: Vec::new(),
            });
            daemon::run(
                input,
                o,
                Box::new(m),
                Box::new(CountingTranscriber { languages: l }),
                options,
            );
        });
        Self {
            stdin,
            out,
            mic,
            languages,
            wav_dir,
            thread: Some(thread),
        }
    }

    fn send(&self, line: &str) {
        self.stdin.send(format!("{line}\n").into_bytes()).unwrap();
    }

    fn wait_for(&self, what: &str, pred: impl Fn(&[Event]) -> bool) -> Vec<Event> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let events = self.out.events();
            if pred(&events) {
                return events;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; got {events:#?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn quit(mut self) -> Vec<Event> {
        self.send("quit");
        self.thread.take().unwrap().join().unwrap();
        let _ = std::fs::remove_dir_all(&self.wav_dir);
        self.out.events()
    }
}

fn kinds(events: &[Event], session: Option<u64>) -> Vec<String> {
    events
        .iter()
        .filter(|e| session.is_none() || e.session_id == session)
        .filter(|e| e.kind != "level")
        .map(|e| e.kind.clone())
        .collect()
}

fn count(events: &[Event], kind: &str) -> usize {
    events.iter().filter(|e| e.kind == kind).count()
}

#[test]
fn a_session_streams_levels_then_finalizes_in_swift_order() {
    let h = Harness::new("order", Mic::default(), false);
    h.wait_for("ready", |e| count(e, "ready") == 1);
    h.send("start:7");
    h.wait_for("listening", |e| e.iter().any(|e| e.text == "listening"));
    h.mic.say(&vec![0.06; 16_000]);
    let events = h.wait_for("a level", |e| count(e, "level") > 0);
    let level = events.iter().find(|e| e.kind == "level").unwrap();
    assert_eq!(level.session_id, Some(7));
    assert_eq!(level.text, "0.500", "rms 0.06 / 0.12");

    h.send("stop:7");
    let events = h.wait_for("complete", |e| {
        count(e, "complete") == 1 && count(e, "ready") == 2
    });
    assert_eq!(
        kinds(&events, Some(7)),
        ["status", "final", "audio_file", "complete"]
    );
    let final_text = events.iter().find(|e| e.kind == "final").unwrap();
    assert_eq!(final_text.text, "heard 16000 samples");
    let wav = &events.iter().find(|e| e.kind == "audio_file").unwrap().text;
    assert!(
        wav.contains("o8_dictation_7_") && wav.ends_with(".wav"),
        "{wav}"
    );
    let spec = hound::WavReader::open(wav).unwrap().spec();
    assert_eq!(
        (spec.sample_rate, spec.channels, spec.bits_per_sample),
        (16_000, 1, 16)
    );
    assert_eq!(
        events.last().unwrap().kind,
        "ready",
        "ready follows every stop"
    );

    let all = h.quit();
    assert_eq!(all[0].text, "capture:test-mic");
    assert_eq!(all[1].kind, "ready");
}

#[test]
fn a_stale_stop_is_ignored_and_a_new_start_finalizes_the_old_session() {
    let h = Harness::new("fence", Mic::default(), false);
    h.wait_for("ready", |e| count(e, "ready") == 1);
    h.send("start:1");
    h.wait_for("listening", |e| e.iter().any(|e| e.text == "listening"));
    h.mic.say(&vec![0.1; 4_000]);
    h.send("stop:99");
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        count(&h.out.events(), "complete"),
        0,
        "stop for another session must be ignored"
    );

    h.send("start:2");
    let events = h.wait_for("session 1 complete", |e| {
        e.iter()
            .any(|e| e.kind == "complete" && e.session_id == Some(1))
    });
    assert!(events
        .iter()
        .any(|e| e.kind == "final" && e.session_id == Some(1)));
    h.wait_for("session 2 listening", |e| {
        e.iter()
            .any(|e| e.text == "listening" && e.session_id == Some(2))
    });
    h.send("stop");
    h.wait_for("session 2 complete", |e| {
        e.iter()
            .any(|e| e.kind == "complete" && e.session_id == Some(2))
    });
    h.quit();
}

#[test]
fn silence_and_empty_sessions_complete_without_a_final() {
    let h = Harness::new("silence", Mic::default(), false);
    h.send("start:3");
    h.wait_for("listening", |e| e.iter().any(|e| e.text == "listening"));
    h.mic.say(&vec![0.0; 8_000]);
    h.send("stop:3");
    let events = h.wait_for("complete", |e| count(e, "complete") == 1);
    assert_eq!(
        kinds(&events, Some(3)),
        ["status", "audio_file", "complete"]
    );

    h.send("start:4");
    h.wait_for("listening", |e| {
        e.iter()
            .any(|e| e.text == "listening" && e.session_id == Some(4))
    });
    h.send("stop:4");
    let events = h.wait_for("complete", |e| count(e, "complete") == 2);
    assert_eq!(
        kinds(&events, Some(4)),
        ["status", "complete"],
        "no audio, no file"
    );
    h.quit();
}

#[test]
fn partials_stream_while_recording() {
    let h = Harness::new("partials", Mic::default(), true);
    h.send("start:5");
    h.wait_for("listening", |e| e.iter().any(|e| e.text == "listening"));
    h.mic.say(&vec![0.05; 9_000]);
    let events = h.wait_for("a partial", |e| count(e, "partial") > 0);
    let partial = events.iter().find(|e| e.kind == "partial").unwrap();
    assert_eq!(
        (partial.session_id, partial.text.as_str()),
        (Some(5), "heard 9000 samples")
    );
    h.send("stop:5");
    h.wait_for("complete", |e| count(e, "complete") == 1);
    h.quit();
}

#[test]
fn settings_commands_are_acknowledged() {
    let h = Harness::new("settings", Mic::default(), false);
    h.send("locale:fr-FR");
    h.send("on_device:false");
    h.send("input_device:alsa_input.usb-mic");
    h.send("input_device:default");
    h.send("bogus command");
    let events = h.wait_for("acks", |e| {
        e.iter()
            .filter(|e| e.text.starts_with("input_device:"))
            .count()
            == 2
    });
    let statuses: Vec<_> = events
        .iter()
        .filter(|e| e.kind == "status")
        .map(|e| e.text.as_str())
        .collect();
    assert!(statuses.contains(&"locale:fr-FR"));
    assert!(
        statuses.contains(&"on_device:true"),
        "whisper always runs on-device"
    );
    assert!(statuses.contains(&"input_device:alsa_input.usb-mic"));
    assert_eq!(
        *h.mic.device.lock().unwrap(),
        None,
        "default resets the device"
    );
    h.wait_for("re-prepare", |_| h.languages.lock().unwrap().len() == 2);
    assert_eq!(
        *h.languages.lock().unwrap(),
        [Some("en".to_string()), Some("fr".to_string())]
    );
    h.quit();
}

#[test]
fn capture_failures_become_session_errors_not_crashes() {
    let refusing = Mic {
        refuse: Some("no audio recorder found".into()),
        ..Mic::default()
    };
    let h = Harness::new("refuse", refusing, false);
    h.send("start:8");
    h.send("stop:8");
    let events = h.wait_for("complete", |e| count(e, "complete") == 1);
    assert_eq!(kinds(&events, Some(8)), ["error", "complete"]);
    assert_eq!(
        events.iter().find(|e| e.kind == "error").unwrap().text,
        "no audio recorder found"
    );
    h.quit();

    let h = Harness::new("dies", Mic::default(), false);
    h.send("start:9");
    h.wait_for("listening", |e| e.iter().any(|e| e.text == "listening"));
    (h.mic.fail.lock().unwrap().as_ref().unwrap())("pw-record: no source".into());
    h.wait_for("error", |e| {
        e.iter()
            .any(|e| e.kind == "error" && e.session_id == Some(9))
    });
    h.send("stop:9");
    h.wait_for("complete", |e| count(e, "complete") == 1);
    h.quit();
}

#[test]
fn eof_on_stdin_finalizes_and_exits() {
    let h = Harness::new("eof", Mic::default(), false);
    h.send("start:10");
    h.wait_for("listening", |e| e.iter().any(|e| e.text == "listening"));
    h.mic.say(&vec![0.2; 3_200]);
    let Harness {
        stdin,
        out,
        thread,
        wav_dir,
        ..
    } = h;
    drop(stdin);
    thread.unwrap().join().unwrap();
    let events = out.events();
    assert!(events
        .iter()
        .any(|e| e.kind == "complete" && e.session_id == Some(10)));
    let _ = std::fs::remove_dir_all(wav_dir);
}
