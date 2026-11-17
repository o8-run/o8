//! Saved defaults only; runtime/auth caches, encrypted credentials and migrations defer.
use super::{reply, unavailable, value, Params, ReadContext};
use axum::{
    http::{HeaderValue, StatusCode},
    response::Response,
};
use serde_json::{json, Map, Value};
use std::path::Path;

// Missing/malformed ordinary JSON follows the handler's catch-to-default behavior.
// Read errors, oversized files and profile escapes defer rather than manufacture defaults.
pub(super) fn json_file(store: &ReadContext<'_>, path: &Path) -> Result<Option<Value>, ()> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
        Ok(_) => {}
    }
    let bytes = store.file(path, 8 * 1024 * 1024)?;
    let text = String::from_utf8(bytes).map_err(|_| ())?;
    Ok(serde_json::from_str(&text).ok())
}
pub(super) fn absent(path: &Path) -> bool {
    matches!(std::fs::symlink_metadata(path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
}
pub(super) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub(super) fn spread(v: &Value) -> Result<Map<String, Value>, ()> {
    match v {
        Value::Object(m) => Ok(m.clone()),
        Value::Array(a) => Ok(a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect()),
        // A JS string spreads UTF16 units. Defer non-BMP strings (lone surrogate JSON).
        Value::String(s) if s.chars().all(|c| c as u32 <= 0xffff) => Ok(s
            .chars()
            .enumerate()
            .map(|(i, c)| (i.to_string(), json!(c.to_string())))
            .collect()),
        Value::String(_) => Err(()),
        _ => Ok(Map::new()),
    }
}
pub(super) fn response(status: u16, body: Value, cache: Option<&'static str>) -> Response {
    let mut r = reply(StatusCode::from_u16(status).unwrap(), body);
    r.headers_mut().remove("cache-control");
    if let Some(c) = cache {
        r.headers_mut()
            .insert("cache-control", HeaderValue::from_static(c));
    }
    r
}
fn setup(store: &ReadContext<'_>) -> Result<(u16, Value), ()> {
    let config = json_file(store, &store.directory.join("setup.json"))?
        .unwrap_or_else(|| json!({"setupComplete":false,"skippedSteps":[]}));
    let request_path = store.directory.join("agent-setup-request.json");
    let missing = absent(&request_path);
    let request = json_file(store, &request_path)?;
    if !missing && (request.is_none() || request == Some(Value::Null)) {
        return Ok((
            500,
            json!({"error":{"code":"setup_recovery_unavailable","message":"Could not read the pending setup request."}}),
        ));
    }
    let pending = request
        .as_ref()
        .filter(|v| !v.is_null() && **v != false && **v != 0 && **v != "")
        .is_some_and(|r| {
            !matches!(
                r.get("status").and_then(Value::as_str),
                Some("opened" | "cancelled")
            )
        });
    let mut out = spread(&config)?;
    out.insert("agentSetupPending".into(), json!(pending));
    Ok((200, Value::Object(out)))
}
fn fast_model(model: &str) -> bool {
    let m = model.strip_prefix("anthropic/").unwrap_or(model);
    ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]
        .iter()
        .any(|prefix| {
            m == *prefix
                || m.strip_prefix(prefix).is_some_and(|tail| {
                    tail.starts_with('-')
                        && tail.len() == 9
                        && tail[1..].bytes().all(|b| b.is_ascii_digit())
                })
        })
}
fn tiers(store: &ReadContext<'_>, p: &Params) -> Result<(u16, Value, Option<&'static str>), ()> {
    let model = value(p, "model");
    let standard = json!({"id":"default","label":"Standard"});
    if model.encode_utf16().count() > 200 {
        return Ok((400, json!({"error":"Invalid model."}), None));
    }
    match value(p, "backend") {
        // A live CLI result/cache is not a saved-store reader. Do not synthesize503.
        "codex" => Err(()),
        "claude" => {
            let profile = json_file(store, &store.directory.join("claude-code-worker.json"))?;
            let native = !matches!(
                profile
                    .as_ref()
                    .and_then(|v| v.get("source"))
                    .and_then(Value::as_str),
                Some("openrouter" | "codex-subscription")
            );
            let context = store.defaults_context.as_ref().ok_or(())?;
            let fast = native
                && fast_model(model)
                && !context
                    .get("disableClaudeFast")
                    .and_then(Value::as_bool)
                    .ok_or(())?;
            let config = std::path::PathBuf::from(
                context
                    .get("claudeConfigDir")
                    .and_then(Value::as_str)
                    .ok_or(())?,
            );
            let settings =
                json_file(store, &config.join("settings.json"))?.unwrap_or_else(|| json!({}));
            if fast && settings.is_null() {
                return Ok((
                    503,
                    json!({"options":[standard],"error":"Service tiers could not be checked. Try again."}),
                    Some("no-store"),
                ));
            }
            let options = if fast {
                json!([standard,{"id":"fast","label":"Fast","description":"Uses paid Claude usage credits. Your CLI checks account access."}])
            } else {
                json!([standard])
            };
            Ok((
                200,
                json!({"options":options,"configuredTier":if fast&&settings["fastMode"]==true {"fast"}else{"default"},"source":"claude-code"}),
                Some("no-store"),
            ))
        }
        _ => Ok((
            200,
            json!({"options":[],"source":"runtime-default"}),
            Some("no-store"),
        )),
    }
}
fn presentation(store: &ReadContext<'_>, p: &Params) -> Result<Value, ()> {
    if value(p, "include") == "native" { return super::settings_native::read(store, p); }
    if value(p, "include") != "presentation" {
        return Err(());
    }
    if !absent(&store.directory.join("settings.toml")) {
        return super::settings_presentation::read(store);
    }
    let saved =
        json_file(store, &store.directory.join("operator-defaults.json"))?.unwrap_or(Value::Null);
    Ok(
        json!({"values":{"presentationQuietMode":saved["presentationQuietMode"].as_bool().unwrap_or(false),"notificationsReviewReady":match saved["notificationsReviewReady"].as_str(){Some("off")=>"off",_=>"on"}}}),
    )
}
fn capabilities(p: &Params) -> Result<Value, ()> {
    let id = value(p, "id");
    if id == "remote-customer" {
        return Err(());
    }
    let declarations: Value =
        serde_json::from_str(include_str!("settings_capabilities.json")).map_err(|_| ())?;
    Ok(json!({"id":id,"capabilities":declarations.get(id).unwrap_or(&Value::Null)}))
}
fn keys(store: &ReadContext<'_>) -> Result<Value, ()> {
    // No credential bytes are read here. Any saved/ambient material defers to
    // the canonical encrypted-store owner, including aliases and empty envs.
    if store
        .defaults_context
        .as_ref()
        .and_then(|v| v.get("ambientKeysPresent"))
        .and_then(Value::as_bool)
        != Some(false)
    {
        return Err(());
    }
    if !absent(&store.directory.join(".env.local")) {
        return Err(());
    }
    for name in [
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
    ] {
        if std::env::var_os(name).is_some() {
            return Err(());
        }
    }
    let path = store.directory.join("providers/openrouter.json");
    let missing = absent(&path);
    let record = json_file(store, &path)?;
    if !missing && (record.is_none() || record.as_ref().is_some_and(Value::is_null)) {
        return Err(());
    }
    let empty = json!({});
    let r = record.as_ref().unwrap_or(&empty);
    let enabled = r["enabled"] != false;
    let string = |name: &str| {
        r[name]
            .as_str()
            .map(js_trim)
            .filter(|s| !s.is_empty())
            .map(|s| json!(s))
            .unwrap_or(Value::Null)
    };
    let connection = json!({"enabled":enabled,"checkedAt":string("checkedAt"),"lastOkAt":string("lastOkAt"),"lastError":string("lastError"),"details":if enabled {Value::Null}else{r.get("details").filter(|v|v.is_null()).cloned().ok_or(())?},"state":if enabled{"disconnected"}else{"disabled"}});
    let providers= [
        ("openrouter","OpenRouter","OPENROUTER_API_KEY","sk-or-...","https://openrouter.ai/keys"),
        ("deepseek","DeepSeek","DEEPSEEK_API_KEY","sk-...","https://platform.deepseek.com/api_keys"),
        ("anthropic","Anthropic","ANTHROPIC_API_KEY","sk-ant-...","https://console.anthropic.com/keys"),
        ("openai","OpenAI","OPENAI_API_KEY","sk-...","https://platform.openai.com/api-keys"),
    ].iter().map(|(id,label,env,placeholder,docs)|{let mut p=json!({"id":id,"label":label,"envVar":env,"placeholder":placeholder,"docsUrl":docs,"configured":false,"enabled":if *id=="openrouter"{enabled}else{true},"maskedKey":null});if *id=="openrouter"{p["connection"]=connection.clone();}p}).collect::<Vec<_>>();
    Ok(json!({"providers":providers}))
}
pub(super) fn read(store: &ReadContext<'_>, path: &str, p: &Params) -> Response {
    let result = (|| match path {
        "/api/setup/config" => {
            let (status, body) = setup(store)?;
            Ok(response(status, body, None))
        }
        "/api/runtime/service-tiers" => {
            let (status, body, cache) = tiers(store, p)?;
            Ok(response(status, body, cache))
        }
        "/api/runtime/capabilities" => Ok(response(200, capabilities(p)?, Some("no-store"))),
        "/api/runtime/provider-instances" => Ok(response(
            200,
            super::settings_providers::read(store, p)?,
            None,
        )),
        "/api/v2/keys" => Ok(response(200, keys(store)?, None)),
        "/api/panel/operator-defaults" => Ok(response(
            200,
            presentation(store, p)?,
            Some("no-store, max-age=0"),
        )),
        _ => Err(()),
    })();
    result.unwrap_or_else(|()| unavailable())
}
