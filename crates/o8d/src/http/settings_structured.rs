//! Pure saved-value readers; no reconciliation, path probes, network or writers.
use super::{js_trim, json, Failure, Toml, Value};
fn accepts(choices: &Value, text: &str) -> bool {
    choices.as_array().is_some_and(|items| items.iter().any(|item| item.as_str() == Some(text)))
}
pub(super) fn tier(field: &Value, value: &Toml) -> Result<Value, Failure> {
    let table = value.as_table().ok_or(Failure::Invalid)?;
    let string = |key: &str| table.get(key).and_then(Toml::as_str).ok_or(Failure::Invalid);
    let runtime = string("runtime")?;
    let model = string("model")?;
    let effort = string("effort")?;
    if !accepts(&field["runtimes"], runtime) || !accepts(&field["efforts"], effort) { return Err(Failure::Invalid); }
    Ok(json!({"runtime":runtime,"model":model,"effort":effort}))
}
fn patterns(value: Option<&Toml>, required: bool) -> Result<Vec<String>, Failure> {
    let items = value.and_then(Toml::as_array).ok_or(Failure::Invalid)?;
    if items.len() > 32 || (required && items.is_empty()) { return Err(Failure::Invalid); }
    items.iter().map(|v| {
        let text = v.as_str().ok_or(Failure::Invalid)?;
        if text.is_empty() || text.encode_utf16().count() > 240 || text.starts_with('/')
            || text.contains(['\\', '\0', '\r', '\n', '[', ']', '{', '}']) || text.split('/').any(|s| s == "..") {
            return Err(Failure::Invalid);
        }
        Ok(text.to_owned())
    }).collect()
}
pub(super) fn knowledge(value: &Toml) -> Result<Value, Failure> {
    let items = value.as_array().ok_or(Failure::Invalid)?;
    if items.len() > 32 { return Err(Failure::Invalid); }
    let mut ids = std::collections::HashSet::new();
    let mut paths = std::collections::HashSet::new();
    let mut out = Vec::new();
    for value in items {
        let table = value.as_table().ok_or(Failure::Invalid)?;
        // JS RegExp coerces a non-string id before testing, and Set keeps its identity.
        // Leave those unusual object/array cases to the TypeScript owner.
        let id = match table.get("id") { Some(Toml::String(s)) => s.as_str(), Some(_) => return Err(Failure::Unknown), None => return Err(Failure::Invalid) };
        let name = table.get("name").and_then(Toml::as_str).ok_or(Failure::Invalid)?;
        let path = table.get("path").and_then(Toml::as_str).ok_or(Failure::Invalid)?;
        if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
            || js_trim(name).is_empty() || name.encode_utf16().count() > 120
            || path.is_empty() || path.encode_utf16().count() > 4096 || path.contains(['\0', '\r', '\n'])
            || !ids.insert(id) || !paths.insert(path) { return Err(Failure::Invalid); }
        let include = patterns(table.get("include"), true)?;
        let exclude = patterns(table.get("exclude"), false)?;
        out.push(json!({"id":id,"name":js_trim(name),"path":path,"include":include,"exclude":exclude}));
    }
    Ok(Value::Array(out))
}
fn credential_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let bytes = key.as_bytes();
    const WORDS: &[&[u8]] = &[b"accesstoken",b"access_token",b"access-token",b"apikey",b"api_key",b"api-key",b"auth",b"credential",b"jwt",b"key",b"pass",b"password",b"passwd",b"secret",b"sig",b"signature",b"token"];
    (0..bytes.len()).any(|i| (i == 0 || b"_-".contains(&bytes[i-1])) && WORDS.iter().any(|word| {
        bytes[i..].starts_with(word) && (i + word.len() == bytes.len() || b"_-".contains(&bytes[i+word.len()]))
    }))
}
pub(super) fn endpoint(value: &Toml) -> Result<Value, Failure> {
    let text = js_trim(value.as_str().ok_or(Failure::Invalid)?);
    if text.is_empty() { return Ok(json!(text)); }
    // Parse failures can differ between WHATWG implementations. Defer rather than
    // accidentally projecting a URL that Node considers credential-bearing.
    let url = url::Url::parse(text).map_err(|_| Failure::Unknown)?;
    if !url.username().is_empty() || url.password().is_some_and(|s| !s.is_empty())
        || url.query_pairs().any(|(key, _)| credential_key(&key)) { return Err(Failure::Invalid); }
    Ok(json!(text))
}
