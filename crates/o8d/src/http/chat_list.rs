//! Saved chat listing. TypeScript retains cleanup and live parked projections.
use super::*;
use chrono::{DateTime, Utc};

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
// ECMAScript WhiteSpace + LineTerminator: Rust additionally treats NEL as space
// and omits BOM, both of which change saved titles and diagnostic detection.
fn js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn trimmed(v: &Value) -> Value {
    v.as_str()
        .map(|s| s.trim_matches(js_space))
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null)
}
fn slice(s: &str, limit: usize) -> Option<String> {
    // A cut inside a surrogate pair needs a lone JS surrogate; defer that case.
    String::from_utf16(&s.encode_utf16().take(limit).collect::<Vec<_>>()).ok()
}
fn preview(s: &str, limit: usize) -> Option<String> {
    Some(format!(
        "{}{}",
        slice(s, limit)?.replace('\n', " "),
        if s.encode_utf16().count() > limit {
            "..."
        } else {
            ""
        }
    ))
}
fn timestamp(ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn model(id: &str, data: &Value) -> String {
    if let Some(s) = trimmed(&data["model"]).as_str() {
        return s.to_owned();
    }
    match data["backend"].as_str().unwrap_or("") {
        "claude" => return "claude-code".into(),
        "codex" => return "codex".into(),
        "openclaw" => return "openclaw".into(),
        "hermes" => return "hermes".into(),
        _ => {}
    }
    for (key, value) in [("claude", "claude-code"), ("codex", "codex")] {
        if !trimmed(&data["orchestratorSessionIds"][key]).is_null() {
            return value.into();
        }
    }
    if id.starts_with("thoughts-") {
        "claude-code"
    } else {
        "unknown"
    }
    .into()
}
fn legacy_title(s: &str) -> bool {
    let Some(date) = s.strip_prefix("Orchestrator session · ") else {
        return false;
    };
    date.len() == 16
        && date.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b' ',
            13 => b == b':',
            _ => b.is_ascii_digit(),
        })
}
fn probe(s: &str) -> bool {
    let normalized = s
        .trim_matches(js_space)
        .split(js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    normalized
        .strip_suffix(['.', '!'])
        .unwrap_or(&normalized)
        .to_lowercase()
        == "reply with exactly: terminal chat is connected"
}

pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    match listing(store, params) {
        Ok(rows) => reply(StatusCode::OK, json!({"conversations":rows})),
        Err(()) => unavailable(),
    }
}
fn listing(store: &ReadContext<'_>, params: &Params) -> Result<Vec<Value>, ()> {
    let root = store.directory.join("chat-history");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(vec![]);
    };
    let db = store.database()?;
    if db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_snapshots WHERE state = 'parked')",
            [],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|_| ())?
    {
        return Err(());
    }
    let mut statement = db
        .prepare("SELECT key,value FROM app_state WHERE key >= ? AND key < ?")
        .map_err(|_| ())?;
    let prefix = "inbox:subject:[\"conversation\",";
    let rows = statement
        .query_map([prefix, "inbox:subject:[\"conversation\"-"], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| ())?;
    let mut states = HashMap::new();
    for row in rows {
        let (key, raw) = row.map_err(|_| ())?;
        // TS parses the entire preference prefix before entering its file loop.
        let Ok(state) = serde_json::from_str::<Value>(&raw) else {
            return Ok(vec![]);
        };
        states.insert(key, state);
    }
    let include = value(params, "include") == "orchestrator";
    let archived = value(params, "archived");
    let search = value(params, "q").to_lowercase();
    let mut files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort_by_cached_key(|p| {
        p.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .encode_utf16()
            .collect::<Vec<_>>()
    });
    let mut output = Vec::new();
    for path in files {
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(data) = store.json(&path) else {
            continue;
        };
        let Some(messages) = data["messages"].as_array() else {
            continue;
        };
        let users: Vec<_> = messages.iter().filter(|m| m["role"] == "user").collect();
        if (!truthy(&data["title"]) || data["title"].as_str().is_some_and(probe))
            && users.len() == 1
            && users[0]["content"].as_str().is_some_and(probe)
        {
            continue;
        }
        if !include && id.starts_with("thoughts-") {
            continue;
        }
        if value(params, "surface") == "mobile-assistant"
            && (!id.starts_with("mobile-chat-")
                || ["o8-operator", "claude-code"].contains(&data["model"].as_str().unwrap_or("")))
        {
            continue;
        }
        let workspace = data["repoPath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| {
                json!(std::fs::canonicalize(s)
                    .unwrap_or_else(|_| thread_context::resolve(Path::new(s)))
                    .to_string_lossy())
            })
            .unwrap_or(Value::Null);
        let subject = json!({"kind":"conversation","id":id,"workspace":workspace,"projectId":trimmed(&data["projectId"])});
        let key = format!("inbox:subject:{}", json!(["conversation", workspace, id]));
        let state = states.get(&key);
        let pin = state
            .and_then(|s| s.get("pinnedAt"))
            .cloned()
            .unwrap_or_else(|| {
                if data["pinned"] == true {
                    json!("1970-01-01T00:00:00.000Z")
                } else {
                    Value::Null
                }
            });
        if messages.is_empty()
            && pin.is_null()
            && data["starred"] != true
            && !(include && data["orchestratorVisible"] == true)
        {
            // This GET owns opportunistic GC in TypeScript. Deferring before
            // archive/search filters preserves that writer's side effects.
            let modified = std::fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .map_err(|_| ())?;
            if std::time::SystemTime::now()
                .duration_since(modified)
                .is_ok_and(|age| age.as_millis() > 3_600_000)
            {
                return Err(());
            }
            continue;
        }
        let archived_at = if !trimmed(&data["archivedAt"]).is_null() {
            data["archivedAt"].clone()
        } else {
            Value::Null
        };
        if (archived == "only" && archived_at.is_null())
            || (archived != "only"
                && !["include", "true", "1"].contains(&archived)
                && !archived_at.is_null())
        {
            continue;
        }
        let metadata = std::fs::metadata(&path).map_err(|_| ())?;
        let mtime = DateTime::<Utc>::from(metadata.modified().map_err(|_| ())?)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let first = users.first().copied();
        let title = if id.starts_with("thoughts-") {
            let title = data["title"].as_str().unwrap_or("").trim_matches(js_space);
            if title.is_empty() || legacy_title(title) {
                "Untitled conversation".to_owned()
            } else {
                title.to_owned()
            }
        } else if truthy(&data["title"]) {
            data["title"].as_str().ok_or(())?.to_owned()
        } else if let Some(first) = first {
            preview(first["content"].as_str().ok_or(())?, 60).ok_or(())?
        } else if messages.is_empty() {
            return Err(());
        }
        // Local-time placeholder title remains TS-owned.
        else {
            "Untitled conversation".into()
        };
        let tail = messages
            .last()
            .map(|m| m["content"].as_str().ok_or(()))
            .transpose()?
            .unwrap_or("");
        let all_text = messages
            .iter()
            .map(|m| m["content"].as_str().ok_or(()))
            .collect::<Result<Vec<_>, _>>()?
            .join(" ");
        let repo_text = ["repoName", "repoPath", "repoBranch"]
            .into_iter()
            .filter_map(|key| data[key].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if !search.is_empty()
            && ![all_text.as_str(), title.as_str(), repo_text.as_str()]
                .iter()
                .any(|s| s.to_lowercase().contains(&search))
        {
            continue;
        }
        let last_spoke = messages
            .iter()
            .filter_map(|m| m["timestamp"].as_f64())
            .filter(|v| v.is_finite() && *v > 0.0)
            .fold(0.0, f64::max);
        let modified = if last_spoke > 0.0 {
            let Some(iso) = timestamp(last_spoke as i64) else {
                continue;
            };
            iso
        } else {
            mtime.clone()
        };
        let backend = data["backend"].as_str().filter(|s| {
            [
                "codex", "claude", "openclaw", "hermes", "acp", "collide", "fable", "o8",
                "opencode", "pi", "muse",
            ]
            .contains(s)
        });
        let mut row = json!({"tabId":id,"title":title,"preview":preview(tail,100).ok_or(())?,"empty":messages.is_empty(),"messageCount":messages.len(),"model":model(id,&data),
            "savedAt":if truthy(&data["savedAt"]) {data["savedAt"].clone()} else {json!(mtime)},"modifiedAt":modified,"starred":if truthy(&data["starred"]) {data["starred"].clone()} else {json!(false)},"pinned":!pin.is_null(),
            "planText":if !trimmed(&data["planText"]).is_null() {data["planText"].clone()} else {Value::Null},"firstUserMessage":if let Some(first) = first { json!(slice(first["content"].as_str().ok_or(())?,500).ok_or(())?) } else { Value::Null } ,
            "projectId":trimmed(&data["projectId"]),"backend":backend,"agent":trimmed(&data["agent"]),"archivedAt":archived_at,"inboxSubject":subject});
        for field in ["repoName", "repoPath", "repoBranch", "remoteUrl"] {
            row[field] = if truthy(&data[field]) {
                data[field].clone()
            } else {
                Value::Null
            };
        }
        if let Some(state) = state {
            for field in [
                "settledOverride",
                "settledAt",
                "unsettledAt",
                "pinOrderKey",
                "activeOrderKey",
                "autoSettleDisabledAt",
            ] {
                if let Some(v) = state.get(field).filter(|v| !v.is_null()) {
                    row[field] = v.clone();
                }
            }
        }
        if let Some(state) = state {
            // appendInboxPreferences checks undefined, not null, for revisions.
            if let Some(revision) = state.get("inboxRevision") {
                row["inboxRevision"] = revision.clone();
            }
            if state["settledOverride"] == "settled"
                && truthy(&state["autoSettledReason"])
                && truthy(&state["autoSettledAt"])
                && state["settledAt"] == state["autoSettledAt"]
            {
                row["autoSettledReason"] = state["autoSettledReason"].clone();
            }
        }
        if !pin.is_null() {
            row["pinnedAt"] = pin;
        }
        output.push(row);
    }
    output.sort_by(|a, b| {
        truthy(&b["pinned"])
            .cmp(&truthy(&a["pinned"]))
            .then(truthy(&b["starred"]).cmp(&truthy(&a["starred"])))
            .then_with(|| b["modifiedAt"].as_str().cmp(&a["modifiedAt"].as_str()))
    });
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(Store);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0.directory);
        }
    }
    fn fixture() -> Fixture {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("o8-chat-list-{}-{id}", std::process::id()));
        std::fs::create_dir_all(directory.join("chat-history")).unwrap();
        let database = directory.join("fixture.db");
        let db = Connection::open(&database).unwrap();
        db.execute_batch("CREATE TABLE workspace_snapshots(state TEXT); CREATE TABLE app_state(key TEXT, value TEXT);").unwrap();
        Fixture(Store {
            directory: directory.canonicalize().unwrap(),
            database,
        })
    }
    fn write(f: &Fixture, id: &str, extra: Value) {
        let mut record = json!({"title":"Fixture", "messages":[{"role":"user","content":"Review 雪","timestamp":1790812800000i64}],"model":"fixture-model","savedAt":"2026-10-01T00:00:00.000Z"});
        record
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        std::fs::write(
            f.0.directory
                .join("chat-history")
                .join(format!("{id}.json")),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
    fn read(f: &Fixture, pairs: &[(&str, &str)]) -> Vec<Value> {
        listing(
            &ReadContext::new(&f.0),
            &pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
        .unwrap()
    }
    #[test]
    fn filters_archive_mobile_and_orchestrator_without_writing_hidden_empty_records() {
        let f = fixture();
        write(&f, "mobile-chat-visible", json!({}));
        write(
            &f,
            "mobile-chat-archived",
            json!({"archivedAt":"2026-10-02T00:00:00.000Z"}),
        );
        write(&f, "thoughts-hidden", json!({}));
        write(&f, "mobile-chat-empty", json!({"messages":[]}));
        assert_eq!(read(&f, &[]).len(), 1);
        assert_eq!(read(&f, &[("include", "orchestrator")]).len(), 2);
        assert_eq!(
            read(&f, &[("archived", "only")])[0]["tabId"],
            "mobile-chat-archived"
        );
        assert_eq!(
            read(
                &f,
                &[("surface", "mobile-assistant"), ("archived", "include")]
            )
            .len(),
            2
        );
        assert_eq!(read(&f, &[("q", "雪")]).len(), 1);
        assert!(read(&f, &[("q", "no-match")]).is_empty());
        assert!(f
            .0
            .directory
            .join("chat-history/mobile-chat-empty.json")
            .exists());
    }
    #[test]
    fn preserves_conditional_preferences_and_outer_malformed_state_behavior() {
        let f = fixture();
        write(&f, "mobile-chat-visible", json!({}));
        let db = Connection::open(&f.0.database).unwrap();
        db.execute(
            "INSERT INTO app_state VALUES (?,?)",
            [
                "inbox:subject:[\"conversation\",null,\"mobile-chat-visible\"]",
                "{\"pinnedAt\":\"2026-10-01\",\"inboxRevision\":2}",
            ],
        )
        .unwrap();
        let rows = read(&f, &[]);
        assert_eq!(rows[0]["pinned"], true);
        assert_eq!(rows[0]["inboxRevision"], 2);
        assert!(rows[0].get("settledOverride").is_none());
        db.execute("UPDATE app_state SET value = 'not-json'", [])
            .unwrap();
        assert!(read(&f, &[]).is_empty());
    }
    #[test]
    fn javascript_probe_punctuation_and_trim_preserve_real_conversations() {
        assert!(probe(
            "\u{feff}Reply with exactly: terminal chat is connected!\u{feff}"
        ));
        assert!(!probe("Reply with exactly: terminal chat is connected!!"));
        assert!(!probe(
            "Reply with exactly:\u{85}terminal chat is connected"
        ));
        assert_eq!(trimmed(&json!("\u{feff} model \u{feff}")), json!("model"));
        assert_eq!(
            trimmed(&json!("\u{85}model\u{85}")),
            json!("\u{85}model\u{85}")
        );
    }
    #[test]
    fn explicit_null_revision_is_present_while_null_listing_fields_are_omitted() {
        let f = fixture();
        write(&f, "mobile-chat-visible", json!({"pinned":true}));
        let db = Connection::open(&f.0.database).unwrap();
        db.execute(
            "INSERT INTO app_state VALUES (?,?)",
            [
                "inbox:subject:[\"conversation\",null,\"mobile-chat-visible\"]",
                "{\"pinnedAt\":null,\"inboxRevision\":null,\"settledAt\":null}",
            ],
        )
        .unwrap();
        let rows = read(&f, &[]);
        assert_eq!(rows[0]["pinned"], false);
        assert_eq!(rows[0].get("inboxRevision"), Some(&Value::Null));
        assert!(rows[0].get("pinnedAt").is_none());
        assert!(rows[0].get("settledAt").is_none());
    }
    #[test]
    fn utf16_boundaries_and_legacy_titles_do_not_silently_change_content() {
        assert_eq!(slice("a😀z", 2), None);
        assert_eq!(slice("a😀z", 3).as_deref(), Some("a😀"));
        assert!(legacy_title("Orchestrator session · 2026-10-01 00:00"));
        assert!(!legacy_title("Orchestrator session · keep this title"));
    }
}
