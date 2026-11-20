//! #6533: the effort a turn sends when nothing chose one. Only the built-in
//! default is fitted to the selected model's catalogue; saved choices and
//! models the catalogue does not list are sent unchanged.
use super::*;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

const CATALOGUE: &str = r#"{"version":1,"agents":[
  {"id":"claude","models":[{"id":"claude-opus-5-5","efforts":["low","medium","high","xhigh","max"],"defaultEffort":"max"}]},
  {"id":"codex","models":[
    {"id":"gpt-5.6-terra","efforts":["low","medium","high","xhigh"],"defaultEffort":"high"},
    {"id":"gpt-6-luna","efforts":["low","medium","xhigh","max"],"defaultEffort":"max"},
    {"id":"gpt-6-mono","efforts":["low","medium"],"defaultEffort":null}]}]}"#;

struct Case {
    backend: &'static str,
    model: &'static str,
    saved: &'static str,
    source: &'static str,
    catalogue: Option<&'static str>,
    receipt: Option<&'static str>,
}

/// Serves the three reads `context` makes and records the paths it asked for.
fn routing(case: Case) -> (Value, Vec<String>) {
    let http = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = http.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let paths = seen.clone();
    let mut messages = json!([{"role": "user", "content": "Count the files"}]);
    if let Some(effort) = case.receipt {
        messages
            .as_array_mut()
            .unwrap()
            .push(json!({"role": "assistant", "content": "Done", "receipt": {"effort": effort}}));
    }
    let history = json!({"repoPath": "/repo", "backend": case.backend, "model": case.model, "messages": messages}).to_string();
    let defaults = json!({"values": {"thinkingEffort": case.saved}, "sources": {"thinkingEffort": case.source}}).to_string();
    std::thread::spawn(move || {
        for stream in http.incoming() {
            let mut stream = stream.unwrap();
            let mut buf = [0u8; 8192];
            let read = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..read]).to_string();
            let path = head
                .split(' ')
                .nth(1)
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap()
                .to_owned();
            let (status, body) = match path.as_str() {
                "/api/v2/chat-history" => ("200 OK", history.clone()),
                "/api/panel/operator-defaults" => ("200 OK", defaults.clone()),
                "/api/mobile/orchestrator/models" => match case.catalogue {
                    Some(catalogue) => ("200 OK", catalogue.to_owned()),
                    None => (
                        "503 Service Unavailable",
                        r#"{"error":"unavailable"}"#.to_owned(),
                    ),
                },
                _ => ("404 Not Found", "{}".to_owned()),
            };
            paths.lock().unwrap().push(path);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        }
    });
    let client = crate::client::Client::new(&format!("http://127.0.0.1:{port}")).unwrap();
    let session: Session = serde_json::from_value(json!({
        "id": "thoughts-effort", "title": "t", "status": "idle", "repoPath": "/repo", "backend": case.backend
    }))
    .unwrap();
    let routing = client.context(&session).unwrap();
    let asked = seen.lock().unwrap().clone();
    (routing, asked)
}

const MODELS: &str = "/api/mobile/orchestrator/models";

#[test]
fn an_unset_default_the_model_cannot_take_sends_the_catalogue_default() {
    let (routing, asked) = routing(Case {
        backend: "codex",
        model: "gpt-5.6-terra",
        saved: "max",
        source: "default",
        catalogue: Some(CATALOGUE),
        receipt: None,
    });
    assert_eq!(routing["effort"], "high");
    assert!(asked.iter().any(|path| path == MODELS));
}

#[test]
fn an_unset_default_the_model_supports_is_sent_unchanged() {
    for (backend, model) in [("claude", "claude-opus-5-5"), ("codex", "gpt-6-luna")] {
        let (routing, _) = routing(Case {
            backend,
            model,
            saved: "max",
            source: "default",
            catalogue: Some(CATALOGUE),
            receipt: None,
        });
        assert_eq!(routing["effort"], "max", "{model}");
    }
}

#[test]
fn a_saved_unsupported_choice_is_sent_for_the_route_to_refuse() {
    for source in ["file", "env"] {
        let (routing, asked) = routing(Case {
            backend: "codex",
            model: "gpt-5.6-terra",
            saved: "max",
            source,
            catalogue: Some(CATALOGUE),
            receipt: None,
        });
        assert_eq!(routing["effort"], "max", "{source}");
        assert!(
            !asked.iter().any(|path| path == MODELS),
            "a saved choice never consults the catalogue"
        );
    }
}

#[test]
fn without_a_catalogue_entry_no_tier_is_invented() {
    // Catalogue unavailable, model not listed, and a listing with no usable default.
    for (catalogue, model) in [
        (None, "gpt-5.6-terra"),
        (Some(CATALOGUE), "gpt-5.5"),
        (Some(CATALOGUE), "gpt-6-mono"),
    ] {
        let (routing, _) = routing(Case {
            backend: "codex",
            model,
            saved: "max",
            source: "default",
            catalogue,
            receipt: None,
        });
        assert_eq!(routing["effort"], "max", "{model}");
    }
}

#[test]
fn the_last_turns_effort_still_wins() {
    let (routing, asked) = routing(Case {
        backend: "codex",
        model: "gpt-5.6-terra",
        saved: "max",
        source: "default",
        catalogue: Some(CATALOGUE),
        receipt: Some("low"),
    });
    assert_eq!(routing["effort"], "low");
    assert!(!asked.iter().any(|path| path == MODELS));
}
