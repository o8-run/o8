//! GET-only file assets, using Node's request-local target authority and shared descriptor checks.
use super::file_asset_viewer as viewer;
use super::*;
fn mime(path: &str, serve: bool) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        _ if serve => return None,
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        _ => return None,
    })
}
pub(super) fn read(store: &ReadContext<'_>, route: &str, params: &Params) -> Response {
    let result = (|| -> Result<Response, ()> {
        let policy = store.redaction.as_ref().ok_or(())?;
        let ctx = store.defaults_context.as_ref().ok_or(())?;
        let io = route == "/api/panel/file-io";
        let asset = route == "/api/panel/file-asset";
        let serve = route == "/api/panel/serve-image";
        let raw = value(params, "path");
        if raw.is_empty() {
            return if io {
                Err(())
            } else if asset {
                Ok(viewer::raw(
                    StatusCode::BAD_REQUEST,
                    "text/plain;charset=UTF-8",
                    b"path required".to_vec(),
                ))
            } else if serve {
                Ok(viewer::plain_json(
                    StatusCode::BAD_REQUEST,
                    json!({"error":"path param required"}),
                ))
            } else {
                Err(())
            };
        }
        let target = &ctx["fileAssetTarget"];
        let root = target["root"].as_str().ok_or(())?;
        let relative = target["relativePath"].as_str().ok_or(())?;
        if !Path::new(root).is_absolute() || !Path::new(root).is_dir() {
            return Err(());
        }
        // Mobile TS permits a symlink whose realpath is in a media root. Defer those
        // aliases to TS rather than opening a rewritten target in the native path.
        if !io && !asset && !serve && target["sourcePath"].as_str() != target["path"].as_str() {
            return Err(());
        }
        let source = if asset {
            raw
        } else {
            target["path"].as_str().ok_or(())?
        };
        let media_type = if io {
            ""
        } else {
            match mime(source, serve) {
                Some(mime) => mime,
                None if asset => {
                    return Ok(viewer::raw(
                        StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        "text/plain;charset=UTF-8",
                        b"Preview type not supported".to_vec(),
                    ))
                }
                None if serve => {
                    return Ok(viewer::plain_json(
                        StatusCode::BAD_REQUEST,
                        json!({"error":"Not an image file"}),
                    ))
                }
                None => return Err(()),
            }
        };
        let opened = match file_content::open_bytes(root, relative, None, RESPONSE_LIMIT as u64) {
            Ok(value) => value,
            Err(None) => return Err(()),
            Err(Some(error)) if io => {
                return match error.code {
                    "workspace_file_not_found" => viewer::json(
                        policy,
                        StatusCode::NOT_FOUND,
                        json!({"error":"File not found"}),
                    ),
                    "workspace_not_regular_file" => viewer::json(
                        policy,
                        StatusCode::BAD_REQUEST,
                        json!({"error":"Not a file"}),
                    ),
                    _ => Err(()),
                }
            }
            Err(Some(_)) if asset => {
                return Ok(viewer::raw(
                    StatusCode::NOT_FOUND,
                    "text/plain;charset=UTF-8",
                    b"File not found or path refused".to_vec(),
                ))
            }
            Err(Some(error)) if serve => {
                return Ok(viewer::plain_json(
                    error.status,
                    json!({"error":error.message,"code":error.code}),
                ))
            }
            Err(Some(_)) => return Err(()),
        };
        if io {
            if opened.size > ctx["fileReadMaxBytes"].as_u64().ok_or(())?
                || opened.bytes.iter().take(8192).any(|b| *b == 0)
            {
                return Err(());
            }
            let text = std::str::from_utf8(&opened.bytes).map_err(|_| ())?;
            return viewer::json(
                policy,
                StatusCode::OK,
                json!({"content":text,"mtimeMs":if opened.mtime_ms.fract() == 0.0 { json!(opened.mtime_ms as i64) } else { json!(opened.mtime_ms) },"size":opened.size,"path":source}),
            );
        }
        if !asset && !serve {
            return viewer::image(policy, opened.bytes, media_type);
        }
        if matches!(
            media_type,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            viewer::image(policy, opened.bytes, media_type)
        } else {
            viewer::text(policy, opened.bytes, media_type)
        }
    })();
    result.unwrap_or_else(|_| unavailable())
}
