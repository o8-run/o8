//! Descriptor-validated file reads. Scope and output authority are never inferred from a path.
use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;

const READ_LIMIT: u64 = 4 * 1024 * 1024;
struct FileError {
    code: &'static str,
    message: &'static str,
    status: StatusCode,
}
impl FileError {
    fn new(code: &'static str, message: &'static str, status: StatusCode) -> Self {
        Self {
            code,
            message,
            status,
        }
    }
}
fn lexical(root: &Path, raw: &str) -> Option<PathBuf> {
    let mut target = PathBuf::new();
    for component in root.join(raw).components() {
        use std::path::Component;
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                target.pop();
            }
            _ => target.push(component.as_os_str()),
        }
    }
    let relative = target.strip_prefix(root).ok()?;
    if relative.to_string_lossy().starts_with("..") {
        None
    } else {
        Some(target)
    }
}
fn open_bytes(
    root: &str,
    raw: &str,
    preview: Option<u64>,
) -> Result<(Vec<u8>, u64), Option<FileError>> {
    #[cfg(target_os = "linux")]
    {
        use std::os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, OpenOptionsExt},
        };
        use StatusCode as S;
        if Path::new(raw).is_absolute() {
            return Err(Some(FileError::new(
                "workspace_path_invalid",
                "File path must be relative to the workspace.",
                S::FORBIDDEN,
            )));
        }
        let root = Path::new(root);
        if !root.is_absolute()
            || root.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(None);
        }
        let Some(target) = lexical(root, raw) else {
            return Err(Some(FileError::new(
                "workspace_path_invalid",
                "File path must stay inside the workspace.",
                S::FORBIDDEN,
            )));
        };
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x20000 | 0x800)
            .open(&target)
            .map_err(|e| {
                Some(match e.raw_os_error() {
                    Some(2) => {
                        FileError::new("workspace_file_not_found", "File not found.", S::NOT_FOUND)
                    }
                    Some(40) => FileError::new(
                        "workspace_symlink_refused",
                        "Symbolic-link file targets are not allowed.",
                        S::FORBIDDEN,
                    ),
                    _ => FileError::new(
                        "workspace_file_open_failed",
                        "Could not open workspace file.",
                        S::INTERNAL_SERVER_ERROR,
                    ),
                })
            })?;
        let stat = file.metadata().map_err(|_| None)?;
        if !stat.is_file() {
            return Err(Some(FileError::new(
                "workspace_not_regular_file",
                "Workspace target must be a regular file.",
                S::BAD_REQUEST,
            )));
        }
        let opened =
            std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|_| None)?;
        let actual = target.canonicalize().map_err(|_| None)?;
        let real_root = root.canonicalize().map_err(|_| None)?;
        if !actual.starts_with(&real_root) {
            return Err(Some(FileError::new(
                "workspace_path_invalid",
                "Opened file resolves outside the workspace.",
                S::FORBIDDEN,
            )));
        }
        let check = std::fs::symlink_metadata(&target).map_err(|_| None)?;
        if opened != actual
            || check.ino() != stat.ino()
            || check.dev() != stat.dev()
            || check.file_type().is_symlink()
        {
            return Err(None);
        }
        let limit = preview.map(|cap| cap.min(stat.len())).unwrap_or(stat.len());
        if limit > READ_LIMIT {
            return Err(None);
        }
        let mut bytes = Vec::new();
        (&file)
            .take(limit)
            .read_to_end(&mut bytes)
            .map_err(|_| None)?;
        let after = file.metadata().map_err(|_| None)?;
        if after.len() != stat.len()
            || after.mtime() != stat.mtime()
            || after.mtime_nsec() != stat.mtime_nsec()
        {
            return Err(None);
        }
        Ok((bytes, stat.len()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, raw, preview);
        Err(None)
    }
}
pub(super) fn read(store: &ReadContext<'_>, path: &str, params: &Params) -> Response {
    let result = (|| -> Result<Response, ()> {
        let policy = store.redaction.as_ref().ok_or(())?;
        let ctx = store.defaults_context.as_ref().ok_or(())?;
        let panel = path == "/api/panel/file-content";
        let respond = |status, body| -> Result<Response, ()> {
            let body = policy.json(body, &[])?;
            if serde_json::to_vec(&body).map_err(|_| ())?.len() > RESPONSE_LIMIT {
                return Err(());
            }
            Ok(reply(status, body))
        };
        let raw = value(params, "path");
        if raw.is_empty() {
            return respond(
                StatusCode::BAD_REQUEST,
                if panel {
                    json!({"content":null,"error":"path param required"})
                } else {
                    json!({"error":"path required"})
                },
            );
        }
        let (root, relative) = if panel {
            if !value(params, "workspace").is_empty() {
                let root = ctx["fileContentScope"]["repoRoot"].as_str().ok_or(())?;
                if !Path::new(root).is_absolute() || !Path::new(root).is_dir() {
                    return Err(());
                }
                (root.to_owned(), raw.to_owned())
            } else {
                (
                    ctx["gitDiffDefaultRoot"].as_str().ok_or(())?.to_owned(),
                    raw.to_owned(),
                )
            }
        } else {
            let target = &ctx["fileReadTarget"];
            let root = target["root"].as_str().ok_or(())?;
            let relative = target["relativePath"].as_str().ok_or(())?;
            if !Path::new(root).is_absolute() || !Path::new(root).is_dir() {
                return Err(());
            }
            (root.to_owned(), relative.to_owned())
        };
        let preview = if !panel && value(params, "preview") == "1" {
            Some(ctx["fileReadMaxBytes"].as_u64().ok_or(())?)
        } else {
            None
        };
        let (bytes, size) = match open_bytes(&root, &relative, preview) {
            Ok(value) => value,
            Err(None) => return Err(()),
            Err(Some(error)) => {
                return respond(
                    error.status,
                    if panel {
                        json!({"content":null,"error":error.message,"code":error.code})
                    } else if error.code == "workspace_file_not_found" {
                        json!({"error":"File not found","code":error.code,"exists":false})
                    } else {
                        json!({"error":error.message,"code":error.code})
                    },
                )
            }
        };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        // The shared exact redaction domain is ASCII; UTF-8 normalization defers safely.
        if !content.is_ascii() {
            return Err(());
        }
        let body = if panel {
            let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
            if content.len() > 100_000 {
                json!({"content":format!("{}\n\n... (truncated at 100KB)",&content[..100_000]),"contentHash":hash,"path":raw,"truncated":true})
            } else {
                json!({"content":content,"contentHash":hash,"path":raw})
            }
        } else if preview.is_some() {
            json!({"content":content,"path":raw,"exists":true,"size":size,"truncated":size>preview.unwrap_or(size)})
        } else {
            json!({"content":content,"contentHash":format!("{:x}",Sha256::digest(content.as_bytes())),"path":raw,"exists":true})
        };
        respond(StatusCode::OK, body)
    })();
    result.unwrap_or_else(|_| unavailable())
}
