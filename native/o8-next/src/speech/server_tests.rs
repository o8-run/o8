//! `ServerFinish` against a loopback listener: the exact requests the
//! dictation routes receive, and how their answers and refusals read.
use super::server::multipart;
use super::{Finish, Polished, ServerFinish, VoicePrefs};
use crate::client::Client;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::mpsc,
};

struct Request {
    head: String,
    body: Vec<u8>,
}

/// Serves one request with `status` and a JSON `reply`; returns the client
/// pointed at it and the request it received.
fn serve(status: u16, reply: &'static str) -> (ServerFinish, mpsc::Receiver<Request>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sender, received) = mpsc::channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            head.push_str(&line);
        }
        let length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        sender.send(Request { head, body }).unwrap();
        let mut stream = stream;
        write!(
            stream,
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
            reply.len()
        )
        .unwrap();
    });
    let client =
        Client::authenticated(&format!("http://127.0.0.1:{port}"), Some("operator".into()))
            .unwrap();
    (ServerFinish::new(client), received)
}

fn wav(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "o8-speech-server-{name}-{}.wav",
        std::process::id()
    ));
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn speech_transcribe_posts_the_recording_as_multipart_audio() {
    let (server, received) = serve(200, r#"{"text":" heard it "}"#);
    let path = wav("ok", b"RIFF\0\x01wav");
    assert_eq!(server.transcribe(&path), Ok("heard it".into()));
    let _ = std::fs::remove_file(&path);
    let request = received.recv().unwrap();
    assert!(
        request
            .head
            .starts_with("POST /api/dictation/transcribe HTTP/1.1\r\n")
    );
    assert!(request.head.contains("Authorization: Bearer operator\r\n"));
    let boundary = request
        .head
        .lines()
        .find_map(|line| line.strip_prefix("Content-Type: multipart/form-data; boundary="))
        .expect("multipart content type")
        .to_owned();
    assert_eq!(request.body, multipart(&boundary, b"RIFF\0\x01wav"));
    let text = String::from_utf8_lossy(&request.body);
    assert!(text.contains(
        "Content-Disposition: form-data; name=\"audio\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF"
    ));
    assert!(text.ends_with(&format!("\r\n--{boundary}--\r\n")));
}

#[test]
fn speech_transcribe_refusal_keeps_the_route_reason() {
    let (server, _received) = serve(
        503,
        r#"{"error":"Dictation needs an OpenRouter key or an active plan to transcribe."}"#,
    );
    let path = wav("refused", b"RIFF");
    assert_eq!(
        server.transcribe(&path),
        Err("Dictation needs an OpenRouter key or an active plan to transcribe.".into())
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn speech_transcribe_refusal_without_reason_names_the_status() {
    let (server, _received) = serve(502, "{}");
    let path = wav("bare", b"RIFF");
    assert_eq!(
        server.transcribe(&path),
        Err("Transcription returned HTTP 502.".into())
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn speech_polish_posts_the_transcript_for_chat() {
    let (server, received) = serve(200, r#"{"text":"Check the build.","polished":true}"#);
    assert_eq!(
        server.polish(
            "check the build",
            Some("/work/repo"),
            &VoicePrefs::default()
        ),
        Ok(Polished {
            text: "Check the build.".into(),
            cancelled: false
        })
    );
    let request = received.recv().unwrap();
    assert!(
        request
            .head
            .starts_with("POST /api/dictation/polish HTTP/1.1\r\n")
    );
    assert!(request.head.contains("Authorization: Bearer operator\r\n"));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"transcript":"check the build","surface":"chat",
            "context":{"activeRepoPath":"/work/repo"}})
    );
}

#[test]
fn speech_polish_reads_a_spoken_cancel() {
    let (server, received) = serve(200, r#"{"text":"","cancelled":true,"reason":"cancel"}"#);
    assert_eq!(
        server.polish("cancel", None, &VoicePrefs::default()),
        Ok(Polished {
            text: String::new(),
            cancelled: true
        })
    );
    let body: serde_json::Value = serde_json::from_slice(&received.recv().unwrap().body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"transcript":"cancel","surface":"chat"})
    );
}

#[test]
fn speech_unreachable_server_is_reported() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let client = Client::authenticated(&format!("http://127.0.0.1:{port}"), None).unwrap();
    assert_eq!(
        ServerFinish::new(client).polish("hello", None, &VoicePrefs::default()),
        Err("Polish could not reach the o8 server.".into())
    );
}

#[test]
fn speech_polish_sends_the_saved_dictionary_and_instructions() {
    let (server, received) = serve(200, r#"{"text":"Ask Kubectl.","polished":true}"#);
    let prefs = VoicePrefs {
        dictionary: vec!["Kubectl".into(), "o8".into()],
        instructions: "Write o8 in lowercase.".into(),
        // Replacements stay local; the route never sees them.
        replacements: vec![("ask".into(), "Ask".into())],
    };
    server.polish("ask cube control", None, &prefs).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&received.recv().unwrap().body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"transcript":"ask cube control","surface":"chat",
            "context":{"dictionary":["Kubectl","o8"],"instructions":"Write o8 in lowercase."}})
    );
}
