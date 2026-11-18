//! Materialized lane review only. Node owns lane/target and legacy fetch authority.
use super::*;
use sha2::{Digest, Sha256};
const GIT_LIMIT: usize = 10 * 1024 * 1024;
fn safe_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && !s.contains("..")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
}
fn object_id(s: &str) -> bool {
    [40, 64].contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, ()> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 16 * 1024)
        .ok_or(())
}
fn optional<'a>(v: &'a Value, key: &str) -> Result<Option<&'a str>, ()> {
    if v.get(key) == Some(&Value::Null) {
        Ok(None)
    } else {
        text(v, key).map(Some)
    }
}
fn directory(v: &Value) -> Result<(), ()> {
    let path = Path::new(text(v, "path")?);
    if !path.is_absolute() || path.canonicalize().map_err(|_| ())? != path {
        return Err(());
    }
    let m = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if text(v, "dev")? != m.dev().to_string() || text(v, "ino")? != m.ino().to_string() {
            return Err(());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(())
    }
}
fn plain(path: &Path) -> Result<String, ()> {
    #[cfg(unix)]
    {
        use std::{
            io::Read,
            os::unix::fs::{MetadataExt, OpenOptionsExt},
        };
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| ())?;
        let stamp = |m: &std::fs::Metadata| {
            (
                m.dev(),
                m.ino(),
                m.len(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
            )
        };
        let before = file.metadata().map_err(|_| ())?;
        if !before.is_file()
            || before.len() > 16 * 1024
            || stamp(&before) != stamp(&std::fs::symlink_metadata(path).map_err(|_| ())?)
        {
            return Err(());
        }
        let mut bytes = Vec::new();
        (&file)
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > 16 * 1024
            || stamp(&before) != stamp(&file.metadata().map_err(|_| ())?)
            || stamp(&before) != stamp(&std::fs::symlink_metadata(path).map_err(|_| ())?)
        {
            return Err(());
        }
        String::from_utf8(bytes).map_err(|_| ())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(())
    }
}
fn pointer(file: &Path, prefix: &str) -> Result<PathBuf, ()> {
    let raw = plain(file)?;
    let raw = raw.trim().strip_prefix(prefix).ok_or(())?.trim();
    if raw.is_empty() {
        return Err(());
    }
    file.parent()
        .ok_or(())?
        .join(raw)
        .canonicalize()
        .map_err(|_| ())
}
fn no_links(path: &Path, budget: &mut usize, depth: usize) -> Result<(), ()> {
    if *budget == 0 || depth > 64 {
        return Err(());
    }
    *budget -= 1;
    let m = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if m.file_type().is_symlink() {
        return Err(());
    }
    if m.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|_| ())? {
            no_links(&entry.map_err(|_| ())?.path(), budget, depth + 1)?;
        }
    }
    Ok(())
}
fn checkout(target: &Value) -> Result<(), ()> {
    for key in ["worktree", "admin", "common"] {
        directory(&target[key])?;
    }
    let root = Path::new(text(&target["worktree"], "path")?);
    let admin = Path::new(text(&target["admin"], "path")?);
    let common = Path::new(text(&target["common"], "path")?);
    if root != Path::new(text(target, "cwd")?) {
        return Err(());
    }
    let dot = root.join(".git");
    if admin == dot {
        if common != admin || std::fs::symlink_metadata(admin.join("commondir")).is_ok() {
            return Err(());
        }
    } else if pointer(&dot, "gitdir:")? != admin
        || pointer(&admin.join("commondir"), "")? != common
        || pointer(&admin.join("gitdir"), "")? != dot
    {
        return Err(());
    }
    let mut budget = 10_000;
    let operator = [
        "config",
        "description",
        "hooks",
        "info",
        "objects",
        "refs",
        "packed-refs",
        "worktrees",
        "modules",
        "lfs",
        "branches",
        "remotes",
    ];
    for entry in std::fs::read_dir(admin).map_err(|_| ())? {
        let entry = entry.map_err(|_| ())?;
        if admin == common
            && entry
                .file_name()
                .to_str()
                .is_some_and(|s| operator.contains(&s))
        {
            continue;
        }
        no_links(&entry.path(), &mut budget, 0)?;
    }
    let head = plain(&admin.join("HEAD"))?;
    if let Some(raw) = head.trim().strip_prefix("ref:") {
        for relative in [raw.trim().to_owned(), format!("logs/{}", raw.trim())] {
            if relative
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            {
                return Err(());
            }
            let mut current = common.to_owned();
            for part in relative.split('/') {
                current.push(part);
                match std::fs::symlink_metadata(&current) {
                    Ok(m) if m.file_type().is_symlink() => return Err(()),
                    Ok(_) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                    Err(_) => return Err(()),
                }
            }
        }
    }
    Ok(())
}
fn run(target: &Value, args: &[&str]) -> Result<String, ()> {
    checkout(target)?;
    let binding = repository::GitEnvironment {
        worktree: text(&target["worktree"], "path")?,
        admin: text(&target["admin"], "path")?,
        common: text(&target["common"], "path")?,
        home: optional(target, "home")?,
        config_home: optional(target, "configHome")?,
    };
    let mut command = vec![
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "core.pager=cat",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
    ];
    command.extend_from_slice(args);
    repository::git_bound(binding.worktree, &command, 15_000, GIT_LIMIT, &binding)
}
fn max_bytes(raw: &str) -> usize {
    let raw = chat_context_json::trim(raw);
    if raw.starts_with('-') {
        return 64 * 1024;
    }
    let digits = raw
        .strip_prefix('+')
        .unwrap_or(raw)
        .bytes()
        .take_while(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    let parsed = std::str::from_utf8(&digits)
        .ok()
        .and_then(|s| s.parse::<f64>().ok());
    match parsed {
        Some(n) if n.is_finite() && n > 0.0 => (n.min(512.0 * 1024.0)) as usize,
        _ => 64 * 1024,
    }
}
fn base(target: &Value, head: &str) -> ReadResult {
    let raw = &target["baseTarget"];
    let normalized = text(target, "base")?;
    let normalized = if normalized.is_empty() {
        "main"
    } else {
        normalized
    };
    if !safe_ref(normalized) {
        return Err(());
    }
    if raw["kind"] == "creation" {
        let id = text(raw, "ref")?;
        if !object_id(id)
            || run(
                target,
                &["rev-parse", "--verify", &format!("{id}^{{commit}}")],
            )?
            .trim()
            .to_lowercase()
                != id
        {
            return Err(());
        }
        run(target, &["merge-base", "--is-ancestor", id, head])?;
        Ok(
            json!({"baseBranch":normalized,"requestedRef":id,"comparisonRef":id,"mergeBase":id,"fetchedRemoteBase":false,"usedFallback":false,"warning":null}),
        )
    } else if raw["kind"] == "legacy" {
        let requested = text(raw, "requestedRef")?;
        let comparison = text(raw, "comparisonRef")?;
        if raw["baseBranch"] != normalized
            || requested != format!("origin/{normalized}")
            || !safe_ref(comparison)
            || !raw["fetchedRemoteBase"].is_boolean()
            || !raw["usedFallback"].is_boolean()
        {
            return Err(());
        }
        optional(raw, "warning")?;
        let merge = run(target, &["merge-base", comparison, head])?
            .trim()
            .to_owned();
        if !object_id(&merge) {
            return Err(());
        }
        let mut result = raw.clone();
        result.as_object_mut().ok_or(())?.remove("kind");
        result["mergeBase"] = json!(merge);
        Ok(result)
    } else {
        Err(())
    }
}
fn unverified(value: &Value) -> bool {
    match value {
        Value::String(text) => git_diff_redaction::viewer_diff(text),
        Value::Array(values) => values.iter().any(unverified),
        Value::Object(values) => values.values().any(unverified),
        _ => false,
    }
}
pub(super) fn matches(path: &str) -> bool {
    path.strip_prefix("/api/lanes/")
        .and_then(|s| s.strip_suffix("/diff"))
        .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}
pub(super) fn read(store: &ReadContext<'_>, path: &str, params: &Params) -> Response {
    let result = (|| -> ReadResult {
        let target = &store.defaults_context.as_ref().ok_or(())?["laneDiffTarget"];
        let id = path
            .strip_prefix("/api/lanes/")
            .and_then(|s| s.strip_suffix("/diff"))
            .ok_or(())?;
        if target["version"] != 1
            || id.contains('%')
            || text(target, "requestId")? != id
            || target["kind"] != "materialized"
            || target["mergeAvailable"] != true
        {
            return Err(());
        }
        text(target, "laneId")?;
        optional(target, "packetId")?;
        optional(target, "repositoryUuid")?;
        if !safe_ref(text(target, "branch")?) {
            return Err(());
        }
        let policy = store.redaction.as_ref().ok_or(())?;
        let _deadline = repository::Deadline::start();
        let keys = run(
            target,
            &["config", "--includes", "--null", "--name-only", "--list"],
        )?;
        if keys.split('\0').any(|key| {
            let key = key.to_ascii_lowercase();
            key == "diff.external"
                || key == "extensions.partialclone"
                || key.starts_with("filter.")
                || key.starts_with("remote.") && key.ends_with(".promisor")
                || key.starts_with("diff.")
                    && (key.ends_with(".command") || key.ends_with(".textconv"))
        }) {
            return Err(());
        }
        let root = text(target, "cwd")?;
        if Path::new(run(target, &["rev-parse", "--show-toplevel"])?.trim())
            .canonicalize()
            .map_err(|_| ())?
            != Path::new(root)
            || run(target, &["branch", "--show-current"])?.trim() != text(target, "branch")?
        {
            return Err(());
        }
        for _ in 0..2 {
            let head = run(target, &["rev-parse", "HEAD"])?.trim().to_owned();
            if !object_id(&head) {
                return Err(());
            }
            let resolution = base(target, &head)?;
            let against = text(&resolution, "mergeBase")?;
            let stat = run(
                target,
                &["diff", "--no-ext-diff", "--no-textconv", "--stat", against],
            )?;
            let full = run(target, &["diff", "--no-ext-diff", "--no-textconv", against])?;
            if run(target, &["rev-parse", "HEAD"])?.trim() != head {
                continue;
            }
            let size = full.len();
            let max = max_bytes(value(params, "maxBytes"));
            let truncated = size > max;
            let revision = format!(
                "{:x}",
                Sha256::digest(
                    format!("{}\0{head}\0{against}\0{full}", text(target, "laneId")?).as_bytes()
                )
            );
            let raw = if truncated {
                format!("{}\n\n…[diff truncated at {max} bytes of {size} — raise maxBytes or read the file directly]",String::from_utf8_lossy(&full.as_bytes()[..max]))
            } else {
                full
            };
            let diff = if git_diff_redaction::viewer_diff(&raw) {
                #[cfg(target_os = "linux")]
                {
                    git_diff::sanitize_review(root, &raw, policy)?
                }
                #[cfg(not(target_os = "linux"))]
                {
                    git_diff::sanitize_commit(root, &raw, policy)?
                }
            } else if raw.is_empty() {
                raw
            } else {
                "[redacted]".to_owned()
            };
            checkout(target)?;
            let body = json!({"ok":true,"laneId":target["laneId"],"packetId":target["packetId"],"headSha":head,"revision":revision,"base":target["base"],"diffBase":resolution,"branch":target["branch"],"worktreePath":root,"reviewSource":"materialized","repositoryUuid":target["repositoryUuid"],"mergeAvailable":true,"stat":chat_context_json::trim(&stat),"diff":diff,"sizeBytes":size,"truncated":truncated,"maxBytes":max});
            if body
                .as_object()
                .ok_or(())?
                .iter()
                .any(|(key, value)| key != "diff" && unverified(value))
            {
                return Err(());
            }
            return policy.json(body, &[diff]);
        }
        Err(())
    })();
    match result {
        Ok(body) => reply(StatusCode::OK, body),
        Err(()) => unavailable(),
    }
}
