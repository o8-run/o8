#![cfg(feature = "experimental-http")]

#[path = "../src/http/proposal_snooze.rs"]
mod proposal_snooze;

use serde_json::{json, Value};
use std::{fs, path::PathBuf};

#[test]
fn frozen_typescript_requests_match_responses_and_each_persisted_state() {
    let corpus: Value = serde_json::from_str(include_str!("../evidence/proposal-snooze/corpus.json")).unwrap();
    let directory: PathBuf = std::env::temp_dir().join(format!("o8d-snooze-engine-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let file = directory.join("proposal-snooze.json");
    fs::write(&file, serde_json::to_vec(&corpus["initial"]).unwrap()).unwrap();
    let result = std::panic::catch_unwind(|| {
        assert_eq!(corpus["cases"].as_array().unwrap().len(), 100);
        for (index, request) in corpus["cases"].as_array().unwrap().iter().enumerate() {
            let field = |name| proposal_snooze::trim_js(request[name].as_str().unwrap_or(""));
            let (id, file, fix) = (field("id"), field("filePattern"), field("fixPattern"));
            let response = if id.is_empty() || file.is_empty() || fix.is_empty() {
                json!({"status":400,"body":{"ok":false,"error":"id, filePattern, and fixPattern are required for dismiss."}})
            } else {
                let entry = proposal_snooze::dismiss(&directory, id, file, fix, corpus["now"].as_i64().unwrap()).unwrap();
                json!({"status":200,"body":{"ok":true,"snoozedUntil":entry["snoozedUntil"]}})
            };
            let stored: Value = serde_json::from_slice(&fs::read(directory.join("proposal-snooze.json")).unwrap()).unwrap();
            assert_eq!(response["status"], corpus["records"][index]["status"], "status case {index}");
            assert_eq!(response["body"], corpus["records"][index]["body"], "body case {index}");
            assert_eq!(stored, corpus["records"][index]["store"], "persisted state case {index}");
        }
        if let Some(output) = std::env::var_os("O8D_SNOOZE_RUST_STORE_OUTPUT") {
            fs::write(output, fs::read(&file).unwrap()).unwrap();
        }
    });
    fs::remove_dir_all(directory).unwrap();
    if let Err(error) = result { std::panic::resume_unwind(error); }
}
