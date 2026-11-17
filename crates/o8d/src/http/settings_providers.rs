//! Provider inventory: saved configuration only; never decrypt credentials or initialize SQLite.
use super::settings_defaults::{absent, js_trim, json_file, spread};
use super::{value, Params, ReadContext};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn local(store: &ReadContext<'_>) -> Result<Option<Value>, ()> {
    let raw = json_file(store, &store.directory.join("local-acp.json"))?;
    let Some(v) = raw.filter(Value::is_object) else {
        return Ok(None);
    };
    let (Some(name), Some(command), Some(args), Some(router)) = (
        v["name"].as_str(),
        v["command"].as_str(),
        v["args"].as_array(),
        v["useOpenRouter"].as_bool(),
    ) else {
        return Ok(None);
    };
    if js_trim(name).is_empty()
        || name.encode_utf16().count() > 80
        || js_trim(command).is_empty()
        || command.encode_utf16().count() > 1024
        || command.contains(['\r', '\n', '\0'])
        || args.len() > 128
        || args.iter().any(|a| {
            a.as_str()
                .is_none_or(|s| s.encode_utf16().count() > 4096 || s.contains('\0'))
        })
    {
        return Ok(None);
    }
    Ok(Some(
        json!({"name":js_trim(name),"command":js_trim(command),"args":args,"useOpenRouter":router}),
    ))
}
fn js_string(v: Option<&Value>) -> Result<String, ()> {
    Ok(match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(a)) => {
            let mut parts = vec![];
            for v in a {
                parts.push(if v.is_null() {
                    String::new()
                } else {
                    js_string(Some(v))?
                });
            }
            parts.join(",")
        }
    })
}
// A missing database returns an empty inventory in TS. An existing database
// without its schema needs the TS writer and cannot be initialized here.
fn environment_db(store: &ReadContext<'_>) -> Result<Option<Connection>, ()> {
    let path = store.directory.join("acp-environment.sqlite");
    if absent(&path) {
        return Ok(None);
    }
    let path = path.canonicalize().map_err(|_| ())?;
    if !path.starts_with(&store.directory) {
        return Err(());
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;
    db.busy_timeout(std::time::Duration::from_millis(1000))
        .map_err(|_| ())?;
    Ok(Some(db))
}
pub(super) fn read(store: &ReadContext<'_>, p: &Params) -> Result<Value, ()> {
    let raw =
        json_file(store, &store.directory.join("provider-instances.json"))?.unwrap_or(Value::Null);
    let connection = local(store)?;
    let mut instances = vec![];
    if let Some(c) = &connection {
        instances.push(json!({"id":"acp","runtime":"acp","name":c["name"],"enabled":true,"acp":c,"default":true}));
    }
    if let Some(a) = raw.get("instances").and_then(Value::as_array) {
        instances.extend(a.iter().cloned());
    }
    let env_path = store.directory.join("acp-environment.sqlite");
    if env_path
        .canonicalize()
        .is_ok_and(|path| !path.starts_with(&store.directory))
    {
        return Err(());
    }
    let database = environment_db(store);
    // A schema-less valid SQLite DB triggers CREATE TABLE in the TS GET: defer
    // the whole route, rather than return a read while its owner must migrate.
    if let Ok(Some(db)) = &database {
        let count=db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('configuration','credentials')",[],|r|r.get::<_, i64>(0));
        if count.is_ok_and(|n| n < 2) && !instances.is_empty() {
            return Err(());
        }
    }
    let mut inventory = vec![];
    for instance in instances {
        let mut out = spread(&instance)?;
        let env = if instance.is_null() {
            Value::Null
        } else {
            let id = js_string(instance.get("id"))?;
            let connection_id = if id == "acp" {
                if let Some(c) = &connection {
                    let signature =
                        serde_json::to_vec(&json!([c["command"], c["args"], c["useOpenRouter"]]))
                            .map_err(|_| ())?;
                    format!("{:x}", Sha256::digest(signature))
                } else {
                    out.insert("environment".into(), Value::Null);
                    inventory.push(Value::Object(out));
                    continue;
                }
            } else {
                format!("instance:{id}")
            };
            match &database {
                Ok(None) => json!({"connectionId":connection_id,"revision":0,"variables":[]}),
                Err(_) => Value::Null,
                Ok(Some(db)) => {
                    let row = db
                        .query_row(
                            "SELECT revision,variables FROM configuration WHERE connection_id=?",
                            [&connection_id],
                            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                        )
                        .optional();
                    match row {
                        Ok(Some((revision, variables))) => {
                            match serde_json::from_str::<Value>(&variables) {
                                Ok(v) => {
                                    json!({"connectionId":connection_id,"revision":revision,"variables":v})
                                }
                                Err(_) => Value::Null,
                            }
                        }
                        Ok(None) => {
                            json!({"connectionId":connection_id,"revision":0,"variables":[]})
                        }
                        Err(_) => Value::Null,
                    }
                }
            }
        };
        out.insert("environment".into(), env);
        inventory.push(Value::Object(out));
    }
    let selectors = json!({"codex":"CODEX_HOME","claude-code":"CLAUDE_CONFIG_DIR","gemini":"GEMINI_CLI_HOME","hermes":"HERMES_HOME","openclaw":"OPENCLAW_STATE_DIR","opencode":"OPENCODE_CONFIG_DIR","pi":"PI_CODING_AGENT_DIR","goose":"GOOSE_PATH_ROOT","qwen":"QWEN_CODE_HOME","kimi":"KIMI_HOME","antigravity":"ANTIGRAVITY_HOME","copilot-cli":"COPILOT_HOME"});
    let mut out = json!({"instances":inventory,"homeSelectors":selectors});
    let thread = value(p, "thread");
    if !thread.is_empty() {
        let bindings = raw.get("threads").filter(|v| v.is_object() || v.is_array());
        let bound = bindings
            .and_then(|v| {
                if let Some(a) = v.as_array() {
                    thread.parse::<usize>().ok().and_then(|i| a.get(i))
                } else {
                    v.get(thread)
                }
            })
            .cloned();
        let mut t = json!({"id":thread});
        // Plain {} inherits these enumerable-value/function slots in JS.
        if let Some(b) = bound {
            t["instance"] = b;
        } else if thread == "__proto__" {
            t["instance"] = if bindings.is_some_and(Value::is_array) {
                json!([])
            } else {
                json!({})
            };
        } else if ![
            "constructor",
            "toString",
            "valueOf",
            "hasOwnProperty",
            "isPrototypeOf",
            "propertyIsEnumerable",
            "toLocaleString",
            "__defineGetter__",
            "__defineSetter__",
            "__lookupGetter__",
            "__lookupSetter__",
        ]
        .contains(&thread)
        {
            t["instance"] = Value::Null;
        }
        out["thread"] = t;
    }
    Ok(out)
}
