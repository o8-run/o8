//! Preserve JSON.stringify property order for the existing ledger's compaction.
//! This representation is private to composer payloads; other readers retain
//! their own serialization contracts.
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use std::fmt;
pub(crate) fn validate_selection(payload: &serde_json::Value, ingress: bool) -> Result<(), ()> {
    let Some(selection) = payload.get("wsSelection") else {
        return Ok(());
    };
    if !ingress {
        return Err(());
    }
    let fields = selection.as_object().ok_or(())?;
    for (field, value) in fields {
        match field.as_str() {
            "pinBackend" if value.is_boolean() => (),
            "backend" | "model" | "thinkingEffort" | "permissionMode" | "orchestrationMode"
            | "pickedMode" | "serviceTier" | "projectId" | "handoffMode" | "collideBaseBackend"
                if value.is_string() =>
            {
                ()
            }
            _ => return Err(()),
        }
    }
    Ok(())
}

enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}
impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct Read;
        impl<'de> Visitor<'de> for Read {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a composer JSON value")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, v: bool) -> Result<Json, E> {
                Ok(Json::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Json, E> {
                Ok(Json::Number(v as f64))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Json, E> {
                Ok(Json::Number(v as f64))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Json, E> {
                Ok(Json::Number(v))
            }
            fn visit_str<E>(self, v: &str) -> Result<Json, E> {
                Ok(Json::String(v.into()))
            }
            fn visit_string<E>(self, v: String) -> Result<Json, E> {
                Ok(Json::String(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = vec![];
                while let Some(v) = seq.next_element()? {
                    items.push(v);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut fields: Vec<(String, Json)> = vec![];
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| *name == key) {
                        *old = value;
                    } else {
                        fields.push((key, value));
                    }
                }
                Ok(Json::Object(fields))
            }
        }
        de.deserialize_any(Read)
    }
}
fn array_index(key: &str) -> Option<u32> {
    let n = key.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}
impl Json {
    fn write(&self, out: &mut String) -> Result<(), ()> {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Number(n) => {
                let mut buffer = ryu_js::Buffer::new();
                out.push_str(if n.is_finite() {
                    buffer.format_finite(*n)
                } else {
                    "null"
                });
            }
            Self::String(s) => out.push_str(&serde_json::to_string(s).map_err(|_| ())?),
            Self::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out)?;
                }
                out.push(']');
            }
            Self::Object(fields) => {
                // ECMAScript enumerates integer-index keys first; other keys
                // retain insertion order, including after a replacement.
                let mut indexed: Vec<_> = fields
                    .iter()
                    .filter_map(|field| array_index(&field.0).map(|n| (n, field)))
                    .collect();
                indexed.sort_by_key(|(n, _)| *n);
                let ordered = indexed
                    .iter()
                    .map(|(_, field)| *field)
                    .chain(fields.iter().filter(|(k, _)| array_index(k).is_none()));
                out.push('{');
                for (i, (key, value)) in ordered.enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).map_err(|_| ())?);
                    out.push(':');
                    value.write(out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
}
fn set(fields: &mut Vec<(String, Json)>, key: &str, value: Json) {
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == key) {
        *old = value;
    } else {
        fields.push((key.into(), value));
    }
}
pub(super) fn compact(
    raw: &str,
    preserve_steer: bool,
    delivered_media: Option<&str>,
) -> Result<String, ()> {
    let Json::Object(mut fields) = serde_json::from_str(raw).map_err(|_| ())? else {
        return Err(());
    };
    if !preserve_steer {
        set(&mut fields, "text", Json::String(String::new()));
    }
    set(&mut fields, "wireMessage", Json::String(String::new()));
    set(&mut fields, "images", Json::Array(vec![]));
    if let Some(media) = delivered_media {
        set(
            &mut fields,
            "deliveredMedia",
            serde_json::from_str(media).map_err(|_| ())?,
        );
    }
    let mut out = String::new();
    Json::Object(fields).write(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn hashes_and_compaction_match_real_typescript_generated_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/o8d-composer-ledger-vectors.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let raw = vector["serialized"].as_str().unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(raw.as_bytes())),
                vector["hash"].as_str().unwrap()
            );
            assert_eq!(raw.len() as u64, vector["bytes"].as_u64().unwrap());
            assert_eq!(
                compact(raw, false, None).unwrap(),
                vector["compactNext"].as_str().unwrap()
            );
            let media = vector["mediaJson"].as_str();
            let actual = compact(raw, true, media).unwrap();
            assert_eq!(actual, vector["compactSteer"].as_str().unwrap());
        }
    }
}
