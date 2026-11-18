//! Exact byte-viewer wire format. Unsupported text normalization defers to TS.
use super::*;

fn ordered(value: &Value, keys: &[&str]) -> String {
    let fields: Vec<_> = keys
        .iter()
        .filter_map(|key| {
            value.get(key).map(|v| {
                let wire = if *key == "redaction" {
                    metadata(&v["spans"])
                } else {
                    serde_json::to_string(v).unwrap()
                };
                format!("{}:{wire}", serde_json::to_string(key).unwrap())
            })
        })
        .collect();
    format!("{{{}}}", fields.join(","))
}
fn metadata(spans: &Value) -> String {
    let spans: Vec<_> = spans
        .as_array()
        .unwrap()
        .iter()
        .map(|span| ordered(span, &["start", "end", "kind", "path"]))
        .collect();
    format!(
        "{{\"version\":1,\"offsetEncoding\":\"utf-8\",\"spans\":[{}]}}",
        spans.join(",")
    )
}
pub(super) fn raw(status: StatusCode, mime: &str, bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .body(Body::from(bytes))
        .unwrap()
}
pub(super) fn plain_json(status: StatusCode, value: Value) -> Response {
    raw(
        status,
        "application/json",
        ordered(&value, &["error", "code"]).into_bytes(),
    )
}
pub(super) fn json(
    policy: &ViewerRedaction,
    status: StatusCode,
    body: Value,
) -> Result<Response, ()> {
    json_ordered(
        policy,
        status,
        body,
        &[
            "content",
            "mtimeMs",
            "size",
            "path",
            "error",
            "code",
            "redaction",
        ],
    )
}
pub(super) fn json_ordered(
    policy: &ViewerRedaction,
    status: StatusCode,
    body: Value,
    keys: &[&str],
) -> Result<Response, ()> {
    let safe = policy.json(body, &[])?;
    let bytes = ordered(&safe, keys).into_bytes();
    if bytes.len() > RESPONSE_LIMIT {
        return Err(());
    }
    let mut response = raw(status, "application/json", bytes);
    response
        .headers_mut()
        .insert("cache-control", "no-store, max-age=0".parse().unwrap());
    Ok(response)
}
fn refuse(policy: &ViewerRedaction, message: &str) -> Result<Response, ()> {
    json(
        policy,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        json!({"error":message,"code":"binary_preview_refused"}),
    )
}
fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as u32)
}
fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as u32)
}
fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}
fn le32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}
fn ascii(bytes: &[u8], expected: &[u8]) -> bool {
    bytes.len() == expected.len() && bytes.iter().zip(expected).all(|(a, b)| a & 0x7f == *b)
}
fn dimensions(bytes: &[u8], mime: &str) -> Option<(u32, u32)> {
    let size = bytes.len();
    let (w, h) = match mime {
        "image/png" => {
            if size < 24
                || bytes.get(..8)? != b"\x89PNG\r\n\x1a\n"
                || be32(bytes, 8)? != 13
                || !ascii(bytes.get(12..16)?, b"IHDR")
                || bytes.get(size.checked_sub(12)?..)? != b"\0\0\0\0IEND\xaeB`\x82"
            {
                return None;
            }
            (be32(bytes, 16)?, be32(bytes, 20)?)
        }
        "image/gif" => {
            if size < 10
                || !(ascii(bytes.get(..6)?, b"GIF87a") || ascii(bytes.get(..6)?, b"GIF89a"))
                || bytes.last() != Some(&0x3b)
            {
                return None;
            }
            (le16(bytes, 6)?, le16(bytes, 8)?)
        }
        "image/jpeg" => {
            if size < 4 || bytes.get(..2)? != b"\xff\xd8" || bytes.get(size - 2..)? != b"\xff\xd9" {
                return None;
            }
            let mut offset = 2;
            loop {
                if *bytes.get(offset)? != 0xff {
                    return None;
                }
                while bytes.get(offset) == Some(&0xff) {
                    offset += 1;
                }
                let marker = *bytes.get(offset)?;
                offset += 1;
                if marker == 0xd9 || marker == 0xda {
                    return None;
                }
                if marker == 1 || (0xd0..=0xd7).contains(&marker) {
                    continue;
                }
                let len = be16(bytes, offset)? as usize;
                if len < 2 || offset + len > size {
                    return None;
                }
                if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                    if len < 7 {
                        return None;
                    }
                    break (be16(bytes, offset + 5)?, be16(bytes, offset + 3)?);
                }
                offset += len;
            }
        }
        "image/webp" => {
            if size < 30
                || !ascii(bytes.get(..4)?, b"RIFF")
                || !ascii(bytes.get(8..12)?, b"WEBP")
                || le32(bytes, 4)? as u64 + 8 > size as u64
            {
                return None;
            }
            match bytes
                .get(12..16)?
                .iter()
                .map(|b| b & 0x7f)
                .collect::<Vec<_>>()
                .as_slice()
            {
                b"VP8 " => {
                    if bytes.get(23..26)? != b"\x9d\x01\x2a" {
                        return None;
                    }
                    (le16(bytes, 26)? & 0x3fff, le16(bytes, 28)? & 0x3fff)
                }
                b"VP8L" => {
                    if bytes[20] != 0x2f {
                        return None;
                    }
                    let bits = le32(bytes, 21)?;
                    ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
                }
                b"VP8X" => (
                    1 + bytes[24] as u32 + ((bytes[25] as u32) << 8) + ((bytes[26] as u32) << 16),
                    1 + bytes[27] as u32 + ((bytes[28] as u32) << 8) + ((bytes[29] as u32) << 16),
                ),
                _ => return None,
            }
        }
        _ => return None,
    };
    if w == 0 || h == 0 {
        None
    } else {
        Some((w, h))
    }
}
pub(super) fn image(policy: &ViewerRedaction, bytes: Vec<u8>, mime: &str) -> Result<Response, ()> {
    if !matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return refuse(policy, "Preview unavailable for this file type");
    }
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return refuse(policy, "Image exceeds the preview size limit");
    }
    let Some((w, h)) = dimensions(&bytes, mime) else {
        return refuse(policy, "Preview requires a valid image");
    };
    if w as u64 * h as u64 > 100_000_000 {
        return refuse(policy, "Image exceeds the preview size limit");
    }
    hardened(bytes, mime, metadata(&json!([])))
}
pub(super) fn text(policy: &ViewerRedaction, bytes: Vec<u8>, mime: &str) -> Result<Response, ()> {
    if mime != "image/svg+xml" {
        return refuse(policy, "Preview unavailable for this file type");
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return refuse(policy, "Preview requires valid UTF-8 text");
    };
    let (safe, spans) = policy.text(text)?;
    let metadata = metadata(&json!(spans));
    if metadata.len() > 4096 {
        return json(
            policy,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"error":"Use the marked text preview for this file","code":"marked_preview_required"}),
        );
    }
    hardened(safe.into_bytes(), mime, metadata)
}
fn hardened(bytes: Vec<u8>, mime: &str, metadata: String) -> Result<Response, ()> {
    if bytes.len() > RESPONSE_LIMIT {
        return Err(());
    }
    let len = bytes.len();
    let mut response = raw(StatusCode::OK, mime, bytes);
    for (key, value) in [
        ("content-length", len.to_string()),
        ("cache-control", "no-store, max-age=0".to_owned()),
        ("x-content-type-options", "nosniff".to_owned()),
        (
            "content-security-policy",
            "sandbox; default-src 'none'".to_owned(),
        ),
        ("x-o8-viewer-redaction", metadata),
    ] {
        response.headers_mut().insert(
            axum::http::HeaderName::from_static(key),
            value.parse().map_err(|_| ())?,
        );
    }
    Ok(response)
}
