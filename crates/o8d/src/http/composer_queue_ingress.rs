//! Locked v1.8 ingress identity and image-free replay wire. Never reserialize
//! before hashing; only the private persisted sidecar uses parsed JSON.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) fn resolved_thread(value: Option<&str>) -> Option<&str> {
    value
        .map(super::chat_context_json::trim)
        .filter(|s| s.starts_with("thoughts-"))
}
fn encode(fields: &[Option<&str>]) -> Result<Vec<u8>, ()> {
    let mut bytes = vec![];
    for field in fields {
        match field {
            None => bytes.push(0),
            Some(s) => {
                let length = u32::try_from(s.len()).map_err(|_| ())?;
                bytes.push(1);
                bytes.extend_from_slice(&length.to_be_bytes());
                bytes.extend_from_slice(s.as_bytes());
            }
        }
    }
    Ok(bytes)
}
pub(crate) fn identity(
    repo: &str,
    thread: Option<&str>,
    mutation: &str,
) -> Result<(String, String), ()> {
    let thread = resolved_thread(thread);
    let id = encode(&[Some("o8.cq.ws-id.v1"), Some(repo), thread, Some(mutation)])?;
    let target = encode(&[
        Some("o8.cq.wsi-target.v1"),
        Some(repo),
        thread,
        Some(mutation),
    ])?;
    Ok((
        format!("ws-{}", URL_SAFE_NO_PAD.encode(Sha256::digest(id))),
        format!("wsi:{}", URL_SAFE_NO_PAD.encode(Sha256::digest(target))),
    ))
}
pub(crate) struct Ingress {
    pub json: String,
    pub hash: String,
}
pub(crate) fn compact(wire_json: &str, images: &Value) -> Result<Ingress, ()> {
    // serde rejects lone surrogates, as required by the locked UTF-8 contract.
    let mut wire: Value = serde_json::from_str(wire_json).map_err(|_| ())?;
    if !wire.is_object() {
        return Err(());
    }
    let images = images.as_array().ok_or(())?;
    match wire.get_mut("attachments") {
        None if images.is_empty() => (),
        Some(Value::Array(attachments)) if attachments.len() == images.len() => {
            for (index, attachment) in attachments.iter_mut().enumerate() {
                if !attachment.is_object()
                    || !attachment["dataUri"].is_string()
                    || !images[index]["dataUri"].is_string()
                {
                    return Err(());
                }
                let original = attachment["dataUri"].as_str().ok_or(())?;
                let stored = images[index]["dataUri"].as_str().ok_or(())?;
                let (prefix, body) = original.split_once(',').ok_or(())?;
                let (normalized, stored_body) = stored.split_once(',').ok_or(())?;
                if body != stored_body || !prefix.eq_ignore_ascii_case(normalized) {
                    return Err(());
                }
                let mut placeholder = json!({"payloadImageIndex":index});
                if prefix != normalized {
                    let prefix = format!("{prefix},");
                    if prefix.len() > 128 {
                        return Err(());
                    }
                    placeholder["dataUriPrefix"] = json!(prefix);
                }
                attachment["dataUri"] = placeholder;
            }
        }
        _ => return Err(()),
    }
    Ok(Ingress {
        json: serde_json::to_string(&wire).map_err(|_| ())?,
        hash: format!("{:x}", Sha256::digest(wire_json.as_bytes())),
    })
}
pub(crate) fn rebuild(sidecar: &str, images: &Value) -> Result<Value, ()> {
    let mut wire: Value = serde_json::from_str(sidecar).map_err(|_| ())?;
    if !wire.is_object() {
        return Err(());
    }
    let images = images.as_array().ok_or(())?;
    match wire.get_mut("attachments") {
        None if images.is_empty() => (),
        Some(Value::Array(attachments)) if attachments.len() == images.len() => {
            for (index, attachment) in attachments.iter_mut().enumerate() {
                let placeholder = attachment["dataUri"].as_object().ok_or(())?;
                if placeholder.get("payloadImageIndex") != Some(&json!(index))
                    || placeholder
                        .keys()
                        .any(|k| k != "payloadImageIndex" && k != "dataUriPrefix")
                {
                    return Err(());
                }
                let stored = images[index]["dataUri"].as_str().ok_or(())?;
                let original = if let Some(prefix) = placeholder.get("dataUriPrefix") {
                    let prefix = prefix
                        .as_str()
                        .filter(|s| s.len() <= 128 && s.ends_with(','))
                        .ok_or(())?;
                    let (normalized, body) = stored.split_once(',').ok_or(())?;
                    if !prefix[..prefix.len() - 1].eq_ignore_ascii_case(normalized) {
                        return Err(());
                    }
                    format!("{prefix}{body}")
                } else {
                    stored.into()
                };
                attachment["dataUri"] = json!(original);
            }
        }
        _ => return Err(()),
    }
    Ok(wire)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mixed_case_prefix_is_bounded_and_round_trips_without_duplicate_image_bytes() {
        let wire = r#"{"attachments":[{"dataUri":"DATA:image/PNG;Base64,YQ=="}]}"#;
        let images = json!([{"dataUri":"data:image/png;base64,YQ=="}]);
        let saved = compact(wire, &images).unwrap();
        let parsed: Value = serde_json::from_str(&saved.json).unwrap();
        assert_eq!(
            parsed["attachments"][0]["dataUri"],
            json!({"payloadImageIndex":0,"dataUriPrefix":"DATA:image/PNG;Base64,"})
        );
        assert_eq!(saved.hash, format!("{:x}", Sha256::digest(wire.as_bytes())));
        assert!(!saved.json.contains("YQ=="));
        assert_eq!(
            rebuild(&saved.json, &images).unwrap(),
            serde_json::from_str::<Value>(wire).unwrap()
        );
        let mut bad = parsed.clone();
        bad["attachments"][0]["dataUri"]["dataUriPrefix"] = json!("data:image/jpeg;base64,");
        assert!(rebuild(&bad.to_string(), &images).is_err());
        bad["attachments"][0]["dataUri"]["dataUriPrefix"] = json!("x".repeat(129));
        assert!(rebuild(&bad.to_string(), &images).is_err());
    }
    #[test]
    fn locked_v18_vectors_match_all_identity_bytes_and_wire_placeholders() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/composer-queue-v1.8-vectors.json"
        ))
        .unwrap();
        let vectors = fixture["idVectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 7);
        let mut null_keys = vec![];
        for vector in vectors {
            let input = &vector["input"];
            let repo = input["repoKey"].as_str().unwrap();
            let mutation = input["clientMutationId"].as_str().unwrap();
            let raw_thread = input["wireThreadId"].as_str();
            let thread = resolved_thread(raw_thread);
            assert_eq!(json!(thread), vector["resolvedThreadId"]);
            let encoded =
                encode(&[Some("o8.cq.ws-id.v1"), Some(repo), thread, Some(mutation)]).unwrap();
            let hex: String = encoded.iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(hex, vector["encodedIdInputHex"]);
            let (id, target) = identity(repo, raw_thread, mutation).unwrap();
            assert_eq!(id, vector["wsId"]);
            assert_eq!(target, vector["wsiTarget"]);
            assert_eq!(id.len(), 46);
            assert_eq!(target.len(), 47);
            if thread.is_none() {
                null_keys.push((id, target));
            }
        }
        assert_eq!(null_keys.len(), 4);
        assert!(null_keys.iter().all(|key| key == &null_keys[0]));
        let ingress = &fixture["ingress"];
        let wire = ingress["wireJson"].as_str().unwrap();
        assert_eq!(
            wire.len(),
            ingress["wireJsonUtf8Bytes"].as_u64().unwrap() as usize
        );
        let parsed: Value = serde_json::from_str(wire).unwrap();
        let images = json!(parsed["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| json!({"dataUri":a["dataUri"]}))
            .collect::<Vec<_>>());
        let saved = compact(wire, &images).unwrap();
        assert_eq!(saved.hash, ingress["ingressHash"]);
        assert_eq!(
            serde_json::from_str::<Value>(&saved.json).unwrap(),
            ingress["ingressJsonValue"]
        );
        assert_eq!(rebuild(&saved.json, &images).unwrap(), parsed);
        assert!(compact(r#"{"message":"\ud800"}"#, &json!([])).is_err());
    }
}
