//! Native Settings: declared projection and saved scopes; all writers remain TS-owned.
use super::settings_defaults::js_trim;
use super::{value, Params, ReadContext};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use toml::{Table, Value as Toml};
#[path = "settings_projection.rs"]
mod projection;
#[path = "settings_structured.rs"]
mod structured;
#[derive(Debug)]
enum Failure {
    Unknown,
    Invalid,
}
const GLOBAL_ONLY: [&str; 4] = [
    "knowledgeSources",
    "experimentalNext",
    "localInferenceBaseUrl",
    "telemetryIngestUrl",
];
fn parse_field(field: &Value, v: &Toml) -> Result<Value, Failure> {
    match field["validator"].as_str() {
        Some("acp-model") | Some("threecode-model") => {
            let text = js_trim(v.as_str().ok_or(Failure::Invalid)?);
            if text.is_empty() { return Ok(Value::Null); }
            let alnum = |b: u8| b.is_ascii_alphanumeric();
            let valid = if field["validator"] == "acp-model" {
                text.encode_utf16().count() <= 200 && text.split('/').all(|segment| {
                    !segment.is_empty() && segment.bytes().all(|b| alnum(b) || b"._:@~-".contains(&b))
                })
            } else {
                text.as_bytes().first().is_some_and(|b| alnum(*b))
                    && text.bytes().all(|b| alnum(b) || b"._/:-".contains(&b))
            };
            if valid { Ok(json!(text)) } else { Err(Failure::Invalid) }
        }
        Some("knowledge") => structured::knowledge(v),
        Some("tier") => structured::tier(field, v),
        Some("endpoint") => structured::endpoint(v),
        Some("model") => {
            let text = js_trim(v.as_str().ok_or(Failure::Invalid)?);
            field["choices"].as_array().filter(|choices| choices.iter().any(|c| c.as_str() == Some(text)))
                .map(|_| json!(text)).ok_or(Failure::Invalid)
        }
        Some("runtime-list") => {
            let items = v.as_array().ok_or(Failure::Invalid)?;
            if field["nonEmpty"] == true && items.is_empty() { return Err(Failure::Invalid); }
            let choices = field["choices"].as_array().ok_or(Failure::Unknown)?;
            let mut out = Vec::new();
            for item in items {
                let text = item.as_str().ok_or(Failure::Invalid)?;
                if !choices.iter().any(|c| c.as_str() == Some(text)) { return Err(Failure::Invalid); }
                let value = json!(text);
                if !out.contains(&value) { out.push(value); }
            }
            Ok(Value::Array(out))
        }
        Some("nullable-positive-integer") => {
            if v.as_str() == Some("") { return Ok(Value::Null); }
            let n = v.as_integer().map(|n| n as f64).or_else(|| v.as_float()).ok_or(Failure::Invalid)?;
            if n.is_finite() && n > 0.0 && n <= 9_007_199_254_740_991.0 && n.fract() == 0.0 {
                Ok(json!(n))
            } else { Err(Failure::Invalid) }
        }
        Some("nullable-date") => {
            let text = v.as_str().ok_or(Failure::Invalid)?;
            if text.is_empty() { return Ok(Value::Null); }
            let b = text.as_bytes();
            if b.len() != 10 || b[4] != b'-' || b[7] != b'-'
                || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
                return Err(Failure::Invalid);
            }
            let year = text[..4].parse().map_err(|_| Failure::Invalid)?;
            let month = text[5..7].parse().map_err(|_| Failure::Invalid)?;
            let day = text[8..].parse().map_err(|_| Failure::Invalid)?;
            chrono::NaiveDate::from_ymd_opt(year, month, day).map(|_| json!(text)).ok_or(Failure::Invalid)
        }
        Some("branch-prefix") => {
            let text = js_trim(v.as_str().ok_or(Failure::Invalid)?);
            if text.is_empty() || text.len() > 40 || text.starts_with(['-', '/']) || text.ends_with(['-', '/'])
                || text.contains("//") || text.contains("--")
                || !text.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"/_-".contains(&c)) {
                Err(Failure::Invalid)
            } else { Ok(json!(text)) }
        }
        Some("carrier") => match v.as_str() {
            Some("") => Ok(Value::Null),
            Some("ori") => Ok(json!("ori")),
            _ => Err(Failure::Invalid),
        },
        Some("nullable-bool") => if v.as_str() == Some("") {
            Ok(Value::Null)
        } else {
            v.as_bool().map(|v| json!(v)).ok_or(Failure::Invalid)
        },
        Some("bot-list") | Some("keybindings") => {
            let items = v.as_array().ok_or(Failure::Invalid)?;
            let bindings = field["validator"] == "keybindings";
            if bindings && items.len() > 200 { return Err(Failure::Invalid); }
            let mut out = Vec::new();
            let mut commands = std::collections::HashSet::new();
            for item in items {
                let text = item.as_str().ok_or(Failure::Invalid)?;
                if bindings {
                    if text.encode_utf16().count() > 200 { return Err(Failure::Invalid); }
                    let (command, chord) = text.split_once('=').ok_or(Failure::Invalid)?;
                    if command.is_empty() || chord.is_empty() || !commands.insert(command) {
                        return Err(Failure::Invalid);
                    }
                } else if text.is_empty() { return Err(Failure::Invalid); }
                let value = json!(text);
                if bindings || !out.contains(&value) { out.push(value); }
            }
            Ok(Value::Array(out))
        }
        Some("bool") => v.as_bool().map(|v| json!(v)).ok_or(Failure::Invalid),
        Some("string") => v
            .as_str()
            .map(|v| json!(js_trim(v)))
            .ok_or(Failure::Invalid),
        Some("clock") => v
            .as_str()
            .filter(|text| {
                let b = text.as_bytes();
                b.len() == 5
                    && b[2] == b':'
                    && [0, 1, 3, 4].iter().all(|i| b[*i].is_ascii_digit())
                    && (b[0] - b'0') * 10 + b[1] - b'0' <= 23
                    && (b[3] - b'0') * 10 + b[4] - b'0' <= 59
            })
            .map(|text| json!(text))
            .ok_or(Failure::Invalid),
        Some("enum") => v
            .as_str()
            .filter(|v| {
                field["choices"]
                    .as_array()
                    .is_some_and(|choices| choices.iter().any(|choice| choice.as_str() == Some(*v)))
            })
            .map(|v| json!(v))
            .ok_or(Failure::Invalid),
        Some("review") => v
            .as_str()
            .filter(|v| matches!(*v, "off" | "on"))
            .map(|v| json!(v))
            .ok_or(Failure::Invalid),
        Some("number") => {
            let n = v
                .as_integer()
                .map(|n| n as f64)
                .or_else(|| v.as_float())
                .ok_or(Failure::Invalid)?;
            let b = &field["bounds"];
            if !n.is_finite()
                || n < b[0].as_f64().unwrap()
                || n > b[1].as_f64().unwrap()
                || (b[2] == true && n.fract() != 0.0)
                || (b[3] == true && n == b[0].as_f64().unwrap())
            {
                return Err(Failure::Invalid);
            };
            Ok(if n == 0.0 { json!(0) } else { json!(n) })
        }
        _ => Err(Failure::Unknown),
    }
}
fn parse_layer(doc: &Table, fields: &[Value], scoped: bool) -> Result<Map<String, Value>, Failure> {
    let mut out = Map::new();
    for f in fields {
        let mut current: Option<&Toml> = None;
        for (i, segment) in f["path"].as_array().unwrap().iter().enumerate() {
            let table = if i == 0 {
                doc
            } else {
                match current {
                    Some(v) => v.as_table().ok_or(Failure::Invalid)?,
                    None => break,
                }
            };
            current = table.get(segment.as_str().unwrap());
            if current.is_none() {
                break;
            }
        }
        if let Some(v) = current {
            let parsed = parse_field(f, v)?;
            let key = f["key"].as_str().unwrap();
            if !scoped || !GLOBAL_ONLY.contains(&key) {
                out.insert(key.to_owned(), parsed);
            }
        }
    }
    Ok(out)
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.encode_utf16().count() <= 200
        && !matches!(id, "__proto__" | "constructor" | "prototype")
}
fn selected_layer(
    doc: &Table,
    kind: &str,
    id: Option<&str>,
    fields: &[Value],
) -> Result<Map<String, Value>, ()> {
    let layer = id
        .filter(|id| valid_id(id))
        .and_then(|id| {
            doc.get("scope")
                .and_then(Toml::as_table)
                .and_then(|s| s.get(kind))
                .and_then(Toml::as_table)
                .and_then(|s| s.get(id))
        })
        .and_then(Toml::as_table);
    match layer {
        None => Ok(Map::new()),
        Some(v) => match parse_layer(v, fields, true) {
            Ok(v) => Ok(v),
            Err(Failure::Invalid) => Ok(Map::new()),
            Err(Failure::Unknown) => Err(()),
        },
    }
}
fn string(v: &str) -> Result<String, ()> {
    serde_json::to_string(v)
        .map(|s| s.replace('\u{007f}', "\\u007f"))
        .map_err(|_| ())
}
fn literal(v: &Value) -> Result<String, ()> {
    match v {
        Value::Null => string(""),
        Value::Array(items) => if items.is_empty() { Ok("[]".into()) } else { Ok(format!("[ {} ]", items.iter().map(literal).collect::<Result<Vec<_>, _>>()?.join(", "))) },
        Value::String(s) => string(s),
        Value::Bool(v) => Ok(v.to_string()),
        Value::Number(n) => {
            let f = n.as_f64().ok_or(())?;
            if f == 0.0 {
                Ok("0".into())
            } else if f.fract() == 0.0 && f.abs() > 9_007_199_254_740_991.0 && f.abs() < 1e21 {
                Ok(format!("{f:.1}"))
            } else if f.abs() >= 1e-6 && f.abs() < 1e21 {
                Ok(f.to_string())
            } else {
                Ok(n.to_string())
            }
        }
        _ => Err(()),
    }
}
fn lossless_integers(value: &Toml) -> bool {
    match value {
        Toml::Integer(n) => (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(n),
        Toml::Array(values) => values.iter().all(lossless_integers),
        Toml::Table(table) => table.values().all(lossless_integers),
        _ => true,
    }
}
pub(super) fn read(store: &ReadContext<'_>, p: &Params) -> Result<Value, ()> {
    let context = store.defaults_context.as_ref().ok_or(())?;
    if context["operatorEnvClean"] != true {
        return Err(());
    }
    let machine = context["machineId"].as_str().ok_or(())?;
    let schema: Value =
        serde_json::from_str(include_str!("settings_declarations.json")).map_err(|_| ())?;
    let fields = schema["fields"].as_array().ok_or(())?;
    let project = if js_trim(value(p, "project")).is_empty() {
        None
    } else {
        let id = js_trim(value(p, "project"));
        if valid_id(id) {
            Some(id)
        } else {
            None
        }
    };
    let path = store.directory.join("settings.toml");
    if matches!(std::fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        return legacy(store, fields, project, None);
    }
    for _ in 0..3 {
        let path = store.directory.join("settings.toml");
        let raw = store.file(&path, 8 * 1024 * 1024)?;
        let raw = std::str::from_utf8(&raw).map_err(|_| ())?;
        let doc = raw.parse::<Table>().map_err(|_| ())?;
        if !doc.values().all(lossless_integers) {
            return Err(());
        }
        let global = match parse_layer(&doc, fields, false) {
            Ok(global) => global,
            Err(Failure::Invalid) => return legacy(store, fields, project, Some(raw.as_bytes())),
            Err(Failure::Unknown) => return Err(()),
        };
        let machine_layer = selected_layer(&doc, "machine", Some(machine), fields)?;
        let project_layer = selected_layer(&doc, "project", project, fields)?;
        let mut file = global.clone();
        file.extend(machine_layer.clone());
        let mut values = schema["fallback"].as_object().ok_or(())?.clone();
        let mut sources = values
            .keys()
            .map(|k| (k.clone(), json!("default")))
            .collect::<Map<_, _>>();
        for (k, v) in &file {
            if k == "editorCommand" && v == "" {
                continue;
            }
            values.insert(k.clone(), v.clone());
            sources.insert(k.clone(), json!("file"));
        }
        // The current resolver overrides only these three values for a single-house
        // profile; defaultDispatchModel keeps its independent file/default resolution.
        let house = match values.get("subscriptionProfile").and_then(Value::as_str) {
            Some("claude-only") => Some(("claude", "claude-code")),
            Some("codex-only") => Some(("codex", "codex")),
            _ => None,
        };
        if let Some((backend, runtime)) = house {
            for (key, value) in [("orchestratorBackend", backend), ("reviewerBackend", backend), ("defaultDispatchRuntime", runtime)] {
                values.insert(key.to_owned(), json!(value));
                sources.insert(key.to_owned(), json!("profile"));
            }
        }
        // Project values change effective values only, not the original source labels.
        for (k, v) in &project_layer {
            if !machine_layer.contains_key(k) {
                values.insert(k.clone(), v.clone());
            }
        }
        let text = projection::text(&global, fields)?;
        let extra = projection::additional(&doc, &text)?;
        let bots = super::settings_roster::read(store)?;
        if store.file(&path, 8 * 1024 * 1024)? != raw.as_bytes() {
            continue;
        }
        let mut digest = Sha256::new();
        digest.update(b"present\0");
        digest.update(raw.as_bytes());
        let body = json!({"bots":bots,"values":values,"sources":sources,"scope":{"projectId":project,"keys":fields.iter().filter_map(|f|f["key"].as_str()).filter(|k|!GLOBAL_ONLY.contains(k)).collect::<Vec<_>>(),"layers":{"global":global,"project":project_layer,"machine":machine_layer}},"settingsToml":{"text":text,"revision":format!("{:x}",digest.finalize()),"additionalSettingsSet":extra,"error":null}});
        if serde_json::to_vec(&body).map_err(|_| ())?.len() > super::RESPONSE_LIMIT {
            return Err(());
        }
        return Ok(body);
    }
    Err(())
}

// A bounded legacy reader: unrelated declared legacy settings still defer to TS.
// Invalid fields are ignored individually, unlike an invalid TOML global layer.
fn legacy(store: &ReadContext<'_>, fields: &[Value], project: Option<&str>, invalid: Option<&[u8]>) -> Result<Value, ()> {
    const KEYS: [&str; 6] = ["presentationQuietMode", "notificationsReviewReady", "composerEnterQueues", "botRailEnabledIds", "nativeKeybindings", "apfsDependencyImages"];
    let path = store.directory.join("operator-defaults.json");
    let saved = if matches!(std::fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        None
    } else { Some(store.file(&path, 8 * 1024 * 1024)?) };
    let parsed: Value = saved.as_ref().map(|raw| serde_json::from_slice(raw)).transpose().map_err(|_| ())?.unwrap_or(Value::Null);
    if parsed.get("autoApplyUpdates").is_some() || fields.iter().any(|f| {
        let key = f["key"].as_str().unwrap();
        !KEYS.contains(&key) && parsed.get(key).is_some()
    }) { return Err(()); }
    let schema: Value = serde_json::from_str(include_str!("settings_declarations.json")).map_err(|_| ())?;
    let mut values = schema["fallback"].as_object().ok_or(())?.clone();
    let mut sources = values.keys().map(|key| (key.clone(), json!("default"))).collect::<Map<_, _>>();
    for field in fields.iter().filter(|f| KEYS.contains(&f["key"].as_str().unwrap())) {
        let key = field["key"].as_str().ok_or(())?;
        if let Some(v) = parsed.get(key) {
            if let Ok(toml) = Toml::try_from(v) {
                if let Ok(value) = parse_field(field, &toml) {
                    values.insert(key.to_owned(), value);
                    sources.insert(key.to_owned(), json!("file"));
                }
            }
        }
    }
    let text = if invalid.is_some() { String::new() } else { projection::text(&values, fields)? };
    let global = if invalid.is_some() { Map::new() } else { values.clone() };
    let mut hash = Sha256::new();
    if let Some(raw) = invalid { hash.update(b"present\0"); hash.update(raw); }
    else { hash.update(b"missing\0"); }
    let body = json!({"bots":super::settings_roster::read(store)?,"values":values,"sources":sources,
        "scope":{"projectId":project,"keys":fields.iter().filter_map(|f|f["key"].as_str()).filter(|k|!GLOBAL_ONLY.contains(k)).collect::<Vec<_>>(),"layers":{"global":global,"project":{},"machine":{}}},
        "settingsToml":{"text":text,"revision":format!("{:x}",hash.finalize()),"additionalSettingsSet":false,
        "error":if invalid.is_some(){json!("settings.toml is invalid. Repair it outside this editor, then refresh.")}else{Value::Null}}});
    // Recheck both inputs: this is a read-only view, never a migration or repair.
    if let Some(raw) = invalid {
        if store.file(&store.directory.join("settings.toml"), 8 * 1024 * 1024)? != raw { return Err(()); }
    } else if !matches!(std::fs::symlink_metadata(store.directory.join("settings.toml")), Err(e) if e.kind() == std::io::ErrorKind::NotFound) { return Err(()); }
    match saved {
        Some(raw) => if store.file(&path, 8 * 1024 * 1024)? != raw { return Err(()); },
        None => if !matches!(std::fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) { return Err(()); },
    }
    if serde_json::to_vec(&body).map_err(|_| ())?.len() > super::RESPONSE_LIMIT { return Err(()); }
    Ok(body)
}
