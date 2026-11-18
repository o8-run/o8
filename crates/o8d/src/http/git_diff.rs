//! Git-owned review reads. No writer, migration, or retained repository state.
use super::repository::git;
use super::*;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::io::Read;

#[path = "git_diff_source.rs"]
mod sources;
use sources::sanitize;

const LIMIT: usize = 16 * 1024 * 1024;
fn run(root: &str, args: &[&str]) -> Result<String, ()> {
    git(root, args, 15_000, LIMIT)
}
fn head(root: &str) -> Result<String, ()> {
    Ok(run(root, &["rev-parse", "--verify", "HEAD"])?
        .trim()
        .to_owned())
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.encode_utf16().count() <= 4096
        && !path.starts_with('/')
        && !path.contains(['\\', '\0'])
        && !(path.as_bytes().get(1) == Some(&b':') && path.as_bytes().get(2) == Some(&b'/'))
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
fn safe_ref(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 255
        && !raw.starts_with('-')
        && !raw.contains("..")
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
}
fn expand(raw: &str, home: &str, legacy: bool) -> String {
    if legacy {
        raw.strip_prefix('~')
            .map(|rest| format!("{home}{rest}"))
            .unwrap_or_else(|| raw.to_owned())
    } else if raw == "~" {
        home.to_owned()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        raw.to_owned()
    }
}
// Open before validation and read only from the validated descriptor (Linux).
// Other hosts defer until their descriptor proof is implemented.
fn source(root: &str, path: &str) -> Result<Vec<u8>, ()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::MetadataExt;
        if !relative(path) {
            return Err(());
        }
        let target = Path::new(root).join(path);
        use std::os::unix::fs::OpenOptionsExt;
        // Linux O_NOFOLLOW | O_NONBLOCK: refuse a final symlink and never block opening a swapped FIFO.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x20000 | 0x800)
            .open(&target)
            .map_err(|_| ())?;
        let descriptor = file.metadata().map_err(|_| ())?;
        let lexical = std::fs::symlink_metadata(&target).map_err(|_| ())?;
        let canonical = target.canonicalize().map_err(|_| ())?;
        let actual =
            std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|_| ())?;
        if !descriptor.is_file()
            || lexical.file_type().is_symlink()
            || descriptor.ino() != lexical.ino()
            || descriptor.dev() != lexical.dev()
            || actual != canonical
            || !actual.starts_with(Path::new(root).canonicalize().map_err(|_| ())?)
        {
            return Err(());
        }
        let mut bytes = Vec::new();
        file.take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(());
        }
        Ok(bytes)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, path);
        Err(())
    }
}
struct File {
    path: String,
    original: String,
    status: String,
    add: u64,
    del: u64,
}
struct Snapshot {
    head: String,
    revision: String,
    against: String,
    files: Vec<File>,
    untracked: Vec<String>,
}
fn snapshot(root: &str, base: Option<&str>, expected: Option<&str>) -> Result<Snapshot, ()> {
    let head = head(root)?;
    if expected.is_some_and(|v| v != head) {
        return Err(());
    }
    let against = base
        .filter(|b| safe_ref(b.trim()))
        .and_then(|b| run(root, &["merge-base", "--", b.trim(), &head]).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| head.clone());
    let names = run(
        root,
        &[
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--find-renames",
            &against,
            "--name-status",
            "-z",
            "--",
        ],
    )?;
    let stats = run(
        root,
        &[
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--find-renames",
            &against,
            "--numstat",
            "-z",
            "--",
        ],
    )?;
    let untracked = run(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z", "--"],
    )?;
    let untracked: Vec<String> = untracked
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let mut files = std::collections::BTreeMap::new();
    let mut fields = names.split('\0');
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let first = fields.next().ok_or(())?;
        let renamed = status.starts_with(['R', 'C']);
        let path = if renamed {
            fields.next().ok_or(())?
        } else {
            first
        };
        files.insert(
            path.to_owned(),
            File {
                path: path.to_owned(),
                original: if renamed {
                    first.to_owned()
                } else {
                    String::new()
                },
                status: match status.as_bytes()[0] {
                    b'A' => "added",
                    b'D' => "deleted",
                    b'R' | b'C' => "renamed",
                    _ => "modified",
                }
                .to_owned(),
                add: 0,
                del: 0,
            },
        );
    }
    let mut fields = stats.split('\0');
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let mut f = record.splitn(3, '\t');
        let add = f.next().ok_or(())?.parse().unwrap_or(0);
        let del = f.next().ok_or(())?.parse().unwrap_or(0);
        let mut path = f.next().ok_or(())?;
        if path.is_empty() {
            fields.next().ok_or(())?;
            path = fields.next().ok_or(())?;
        }
        let file = files.get_mut(path).ok_or(())?;
        file.add = add;
        file.del = del;
    }
    for path in &untracked {
        let target = Path::new(root).join(path);
        let stat = std::fs::symlink_metadata(&target).map_err(|_| ())?;
        let add = if stat.file_type().is_symlink() {
            if std::fs::read_link(target)
                .map_err(|_| ())?
                .as_os_str()
                .is_empty()
            {
                0
            } else {
                1
            }
        } else {
            let bytes = source(root, path)?;
            if bytes.is_empty() || bytes.contains(&0) {
                0
            } else {
                bytes.iter().filter(|b| **b == b'\n').count() as u64
                    + u64::from(bytes.last() != Some(&b'\n'))
            }
        };
        files.insert(
            path.clone(),
            File {
                path: path.clone(),
                original: String::new(),
                status: "untracked".to_owned(),
                add,
                del: 0,
            },
        );
    }
    let files: Vec<File> = files.into_values().collect();
    // ASCII lowercase paths without punctuation ambiguity have the same ICU locale order.
    // Defer other multi-file orderings until localeCompare parity is available.
    if files.len() > 1
        && files.iter().any(|f| {
            !f.path
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.')
        })
    {
        return Err(());
    }
    let mut hash = Sha256::new();
    hash.update(format!("{head}\0{against}\0"));
    for file in &files {
        hash.update(format!(
            "{}\0{}\0{}\0{}\0{}\0",
            file.path, file.original, file.status, file.add, file.del
        ));
        match std::fs::symlink_metadata(Path::new(root).join(&file.path)) {
            #[cfg(unix)]
            Ok(stat) => {
                use std::os::unix::fs::MetadataExt;
                hash.update(format!(
                    "{}:{}:{}\0",
                    stat.size(),
                    stat.mtime() as i128 * 1_000_000_000 + stat.mtime_nsec() as i128,
                    stat.mode()
                ));
            }
            _ => hash.update("missing\0"),
        }
    }
    if self::head(root)? != head {
        return Err(());
    }
    Ok(Snapshot {
        head,
        against,
        revision: format!("{:x}", hash.finalize()),
        files,
        untracked,
    })
}
fn file_json(file: &File) -> Value {
    json!({"path":file.path,"status":file.status,"additions":file.add,"deletions":file.del})
}
fn max_bytes(params: &Params, selected: bool) -> usize {
    let cap = if selected {
        512 * 1024
    } else {
        4 * 1024 * 1024
    };
    let raw = value(params, "maxBytes").trim().trim_start_matches('+');
    let digits: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits
        .parse::<usize>()
        .ok()
        .filter(|v| *v > 0)
        .map(|v| v.min(cap))
        .unwrap_or(cap)
}
fn worktree(store: &ReadContext<'_>, path: &str, params: &Params) -> Result<Response, ()> {
    let policy = store.redaction.as_ref().ok_or(())?;
    let context = store.defaults_context.as_ref().ok_or(())?;
    let home = context["projectsHome"].as_str().ok_or(())?;
    let session = params.get("sessionKey").cloned();
    let mut root = params
        .get("worktreePath")
        .map(|s| expand(s.trim(), home, true))
        .filter(|s| !s.is_empty());
    let mut base = params.get("baseBranch").cloned().filter(|s| !s.is_empty());
    let selected = params.get("file");
    let full = path.ends_with("/diff");
    if full && selected.is_some_and(|s| !relative(s)) {
        return Ok(reply(
            StatusCode::BAD_REQUEST,
            policy.json(json!({"error":"invalid_file_path"}), &[])?,
        ));
    }
    if root.is_none() {
        if let Some(session) = session.as_ref().filter(|s| !s.is_empty()) {
            if let Ok(db) = store.database() {
                let lane=db.query_row("SELECT worktree_path, repo_path, base_branch FROM lanes WHERE session_key = ? AND status NOT IN ('archived','completed','failed') LIMIT 1",[session],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?))).optional();
                if let Ok(Some((worktree, repo, branch))) = lane {
                    root = worktree.or(repo);
                    if base.is_none() {
                        base = branch;
                    }
                }
            }
        }
    }
    let max = max_bytes(params, selected.is_some());
    let mut body = json!({"sessionKey":session,"worktreePath":root,"baseBranch":base,"headSha":null,"revision":null,"additions":0,"deletions":0,"fileCount":0,"files":[],"truncated":false});
    if full {
        body["filePath"] = json!(selected);
        body["diff"] = json!("");
        body["sizeBytes"] = json!(0);
        body["sizeBytesExact"] = json!(true);
        body["maxBytes"] = json!(max);
    }
    let error = if root.as_ref().is_none_or(|s| s.is_empty()) {
        Some("worktree_not_found")
    } else if !Path::new(root.as_ref().ok_or(())?).exists() {
        Some("worktree_path_missing")
    } else {
        None
    };
    if let Some(error) = error {
        body["error"] = json!(error);
        return Ok(reply(
            StatusCode::OK,
            if full { policy.json(body, &[])? } else { body },
        ));
    }
    let root = root.ok_or(())?;
    if !repository::supports_native_projection(&root) {
        return Err(());
    }
    let expected = params
        .get("headSha")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    if full {
        if let Some(expected) = expected {
            let current = head(&root)?;
            if expected != current {
                return Ok(reply(StatusCode::CONFLICT,policy.json(json!({"error":"head_changed","expectedHeadSha":expected,"currentHeadSha":current}),&[])?));
            }
        }
    }
    let snapshot = snapshot(&root, base.as_deref(), if full { expected } else { None })?;
    let files: Vec<_> = snapshot
        .files
        .iter()
        .filter(|f| !full || selected.is_none_or(|s| *s == f.path))
        .collect();
    body["headSha"] = json!(snapshot.head);
    body["revision"] = json!(snapshot.revision);
    body["additions"] = json!(files.iter().map(|f| f.add).sum::<u64>());
    body["deletions"] = json!(files.iter().map(|f| f.del).sum::<u64>());
    body["fileCount"] = json!(files.len());
    body["files"] = json!(files.iter().map(|f| file_json(f)).collect::<Vec<_>>());
    if !full {
        return Ok(reply(StatusCode::OK, body));
    }
    let mut diff = String::new();
    if selected.is_none_or(|s| !snapshot.untracked.contains(s)) {
        let mut args = vec![
            "--literal-pathspecs",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            &snapshot.against,
            "--",
        ];
        if let Some(file) = selected {
            args.push(file);
        }
        diff = run(&root, &args)?;
    }
    for file in &snapshot.untracked {
        if selected.is_some_and(|s| s != file) {
            continue;
        }
        if selected.is_none() && !diff.is_empty() {
            diff.push('\n');
        }
        diff.push_str(&run(
            &root,
            &[
                "--literal-pathspecs",
                "diff",
                "--no-index",
                "--no-color",
                "--no-ext-diff",
                "--",
                "/dev/null",
                file,
            ],
        )?);
    }
    if diff.len() > max {
        return Err(());
    } // TS counts bytes observed before stopping its stream; do not invent that count.
    if head(&root)? != snapshot.head {
        return Err(());
    }
    body["sizeBytes"] = json!(diff.len());
    let safe = if !diff.is_empty() && !diff.lines().any(|line| line.starts_with("@@ -")) {
        "[redacted]".to_owned()
    } else {
        sanitize(&root, &diff, policy)?
    };
    body["diff"] = json!(safe);
    Ok(reply(StatusCode::OK, policy.json(body, &[safe])?))
}
fn kind(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "ico" | "bmp" => "image",
        "mp4" | "mov" | "webm" | "m4v" | "avi" | "mkv" => "video",
        "mp3" | "wav" | "m4a" | "ogg" | "flac" | "aac" => "audio",
        "pdf" => "pdf",
        "bin" | "zip" | "gz" | "tar" | "7z" | "dmg" | "exe" | "dll" | "so" | "wasm" | "woff"
        | "woff2" | "ttf" | "otf" | "sqlite" | "db" | "psd" | "sketch" | "heic" | "heif"
        | "parquet" | "xlsx" | "docx" | "pptx" => "binary",
        _ => "text",
    }
}
fn panel(store: &ReadContext<'_>, params: &Params) -> Result<Response, ()> {
    let policy = store.redaction.as_ref().ok_or(())?;
    let context = store.defaults_context.as_ref().ok_or(())?;
    let Some(path) = params
        .get("path")
        .or_else(|| params.get("file"))
        .filter(|s| !s.is_empty())
    else {
        return Ok(reply(
            StatusCode::BAD_REQUEST,
            policy.json(json!({"error":"path param required"}), &[])?,
        ));
    };
    let base = value(params, "base").trim();
    if base.starts_with('-') || base.chars().any(|c| c.is_ascii_control()) {
        return Ok(reply(
            StatusCode::BAD_REQUEST,
            policy.json(json!({"error":"Invalid comparison revision."}), &[])?,
        ));
    }
    let root = expand(
        params
            .get("workspace")
            .or_else(|| params.get("repoPath"))
            .map(String::as_str)
            .unwrap_or(context["gitDiffDefaultRoot"].as_str().ok_or(())?),
        context["projectsHome"].as_str().ok_or(())?,
        false,
    );
    let mut resolved = PathBuf::new();
    let lexical = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        Path::new(&root).join(path)
    };
    for component in lexical.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => (),
            _ => resolved.push(component.as_os_str()),
        }
    }
    let root_path = Path::new(&root);
    if !root_path.is_absolute()
        || root_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(());
    }
    let escapes = resolved
        .strip_prefix(root_path)
        .map(|s| s.to_string_lossy().starts_with(".."))
        .unwrap_or(true);
    if escapes {
        return Ok(reply(
            StatusCode::FORBIDDEN,
            policy.json(
                json!({"error":"File path must stay inside the workspace."}),
                &[],
            )?,
        ));
    }
    if !relative(path) {
        return Err(());
    }
    let mut metadata = json!({"kind":kind(path)});
    if let Ok(stat) = std::fs::symlink_metadata(Path::new(&root).join(path)) {
        if stat.is_dir() {
            metadata = json!({"kind":"directory","diffStatus":"directory"});
        } else if stat.file_type().is_symlink() {
            metadata = json!({"kind":"symlink"});
        } else if let Ok(bytes) = source(&root, path) {
            metadata["size"] = json!(stat.len());
            let binary = kind(path) != "text" && !path.to_ascii_lowercase().ends_with(".svg")
                || bytes.iter().take(8192).any(|b| *b == 0);
            if binary {
                metadata["diffStatus"] = json!("binary");
                if bytes.iter().take(8192).any(|b| *b == 0) && kind(path) == "text" {
                    metadata["kind"] = json!("binary");
                }
            }
        } else {
            return Err(());
        }
    }
    let mut body = json!({"path":path,"diff":""});
    for (k, v) in metadata.as_object().ok_or(())? {
        body[k] = v.clone();
    }
    if metadata["diffStatus"] == "binary" || metadata["diffStatus"] == "directory" {
        body["hasDiff"] = json!(false);
        return Ok(reply(StatusCode::OK, policy.json(body, &[])?));
    }
    if !repository::supports_native_projection(&root) {
        return Err(());
    }
    let ws = value(params, "ignoreWhitespace") == "1";
    let read = |tail: Vec<&str>| -> Result<String, ()> {
        let mut args = vec!["diff", "--no-color"];
        if ws {
            args.push("-w");
        }
        args.extend(tail);
        git(&root, &args, 5000, LIMIT)
    };
    let comparison = if base.is_empty() {
        "HEAD".to_owned()
    } else {
        format!("{base}...HEAD")
    };
    let result = read(vec![&comparison, "--", path]);
    if !base.is_empty() && result.is_err() {
        body["error"] = json!("The committed diff could not be loaded.");
        return Ok(reply(StatusCode::OK, policy.json(body, &[])?));
    }
    let mut diff = result.unwrap_or_default();
    let mut untracked = false;
    if base.is_empty() && diff.is_empty() {
        diff = read(vec!["--cached", "--", path]).unwrap_or_default();
    }
    if base.is_empty() && diff.is_empty() {
        untracked = run(&root, &["status", "--porcelain", "--", path])
            .unwrap_or_default()
            .trim()
            .starts_with("??");
        if untracked {
            diff = read(vec!["--no-index", "--", "/dev/null", path]).unwrap_or_default();
        }
    }
    let binary = diff
        .lines()
        .any(|l| l.starts_with("Binary files ") || l.starts_with("GIT binary patch"));
    let directory = diff.lines().any(|l| {
        l.starts_with("+Subproject commit ")
            || l.starts_with("-Subproject commit ")
            || l == "new file mode 160000"
            || l == "deleted file mode 160000"
    });
    let too_large = diff.len() > 512 * 1024;
    let truncated = diff.chars().count() > 50_000;
    body["isUntracked"] = json!(untracked);
    body["hasDiff"] = json!(!diff.is_empty() && !too_large);
    body["diffStatus"] = json!(if too_large {
        "too_large"
    } else if directory {
        "directory"
    } else if binary {
        "binary"
    } else if truncated {
        "truncated"
    } else if diff.is_empty() {
        "empty"
    } else {
        "ready"
    });
    if binary {
        body["kind"] = json!("binary");
    }
    if directory {
        body["kind"] = json!("directory");
    }
    if binary || directory || too_large {
        diff.clear();
    } else {
        if !diff.is_ascii() {
            return Err(());
        }
        diff = diff.chars().take(50_000).collect();
    }
    let safe = if !diff.is_empty() && !diff.lines().any(|line| line.starts_with("@@ -")) {
        "[redacted]".to_owned()
    } else {
        sanitize(&root, &diff, policy)?
    };
    body["diff"] = json!(safe);
    Ok(reply(StatusCode::OK, policy.json(body, &[safe])?))
}
pub(super) fn read(store: &ReadContext<'_>, path: &str, params: &Params) -> Response {
    let result = if path == "/api/panel/file-diff" {
        panel(store, params)
    } else {
        worktree(store, path, params)
    };
    result.unwrap_or_else(|_| unavailable())
}
