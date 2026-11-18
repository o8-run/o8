//! Commit detail reads after Node's request-local gate and canonical default-root selection.
use super::*;
const LIMIT: usize = 4 * 1024 * 1024;
pub(super) fn is_commit(path: &str) -> bool {
    path.strip_prefix("/api/panel/commits/")
        .is_some_and(|hash| !hash.is_empty() && !hash.contains('/'))
}
fn run(root: &str, args: &[&str]) -> Result<String, ()> {
    repository::git(root, args, 10_000, LIMIT)
}
fn count(raw: &str) -> u64 {
    raw.parse().unwrap_or(0)
}
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.is_ascii()
        && !path.starts_with('"')
        && !path.contains(['\\', '\t', '\r', '\n'])
        && !path.contains(" => ")
}
fn files(root: &str, hash: &str) -> Result<Vec<Value>, ()> {
    // The canonical TS implementation returns no files for a non-worktree repository.
    if run(root, &["rev-parse", "--is-inside-work-tree"])?.trim() != "true" {
        return Ok(Vec::new());
    }
    let numstat = run(
        root,
        &["diff-tree", "--no-commit-id", "--numstat", "-r", "-M", hash],
    )?;
    let status = run(
        root,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "-M",
            hash,
        ],
    )?;
    let patch = run(
        root,
        &[
            "show",
            "--format=",
            "--patch",
            "--find-renames",
            "--unified=3",
            hash,
        ],
    )?;
    if !patch.is_ascii() {
        return Err(());
    }
    let mut states = HashMap::new();
    for line in status.lines().filter(|s| !s.is_empty()) {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 2 || !safe_path(fields[1]) {
            return Err(());
        }
        states.insert(
            fields[1].to_owned(),
            match fields[0].as_bytes().first() {
                Some(b'A') => "added",
                Some(b'D') => "deleted",
                Some(b'M') => "modified",
                _ => "unknown",
            },
        );
    }
    let mut previous = HashMap::<String, Option<String>>::new();
    let mut starts: Vec<_> = patch
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .collect();
    starts.push(patch.len());
    for pair in starts.windows(2) {
        let section = patch[pair[0]..pair[1]]
            .strip_prefix("diff --git ")
            .ok_or(())?;
        let mut lines = section.split('\n');
        let header = lines.next().ok_or(())?;
        let (old, new) = header
            .strip_prefix("a/")
            .and_then(|s| s.split_once(" b/"))
            .ok_or(())?;
        if !safe_path(old) || !safe_path(new) {
            return Err(());
        }
        let mut old = Some(old.to_owned());
        let mut new = Some(new.to_owned());
        for line in lines {
            if line == "--- /dev/null" {
                old = None;
            } else if let Some(path) = line.strip_prefix("--- a/") {
                old = Some(path.to_owned());
            } else if line == "+++ /dev/null" {
                new = None;
            } else if let Some(path) = line.strip_prefix("+++ b/") {
                new = Some(path.to_owned());
            } else if line.starts_with("rename ") {
                return Err(());
            }
        }
        let key = new.as_ref().or(old.as_ref()).ok_or(())?.to_owned();
        previous.insert(key, old);
    }
    let mut files = Vec::new();
    for line in numstat.lines().filter(|s| !s.is_empty()) {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 3 || !safe_path(fields[2]) {
            return Err(());
        }
        let path = fields[2];
        files.push(json!({"path":path,"additions":count(fields[0]),"deletions":count(fields[1]),"status":states.get(path).copied().unwrap_or("unknown"),"previousPath":previous.get(path).cloned().flatten()}));
    }
    if files.len() > 128 {
        return Err(());
    }
    Ok(files)
}
pub(super) fn commit(store: &ReadContext<'_>, path: &str) -> Response {
    let result = (|| -> Result<Response, ()> {
        let policy = store.redaction.as_ref().ok_or(())?;
        let hash = path.strip_prefix("/api/panel/commits/").ok_or(())?;
        // Encoded path segments retain the TypeScript router's decoding behavior.
        if hash.contains('%') {
            return Err(());
        }
        if !(7..=40).contains(&hash.len()) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(reply(
                StatusCode::BAD_REQUEST,
                policy.json(json!({"error":"Invalid commit hash"}), &[])?,
            ));
        }
        let root = store.defaults_context.as_ref().ok_or(())?["gitRefsCommitRoot"]
            .as_str()
            .ok_or(())?;
        if !Path::new(root).is_absolute() || !Path::new(root).is_dir() {
            return Err(());
        }
        let _deadline = repository::Deadline::start();
        if !repository::supports_native_projection(root) {
            return Err(());
        }
        let meta = run(
            root,
            &["log", "-1", "--format=%H%n%s%n%an%n%ae%n%aI%n%b", hash],
        )?;
        if !meta.is_ascii() {
            return Err(());
        }
        let fields: Vec<_> = meta.trim().split('\n').collect();
        if fields.len() < 5 || fields.iter().any(|s| s.starts_with("@@ -")) {
            return Err(());
        }
        let files = files(root, hash)?;
        let stat = run(root, &["diff-tree", "--no-commit-id", "--stat", hash])?;
        let raw = run(root, &["diff-tree", "-p", "--no-commit-id", hash])?;
        if !raw.is_ascii() || !stat.is_ascii() {
            return Err(());
        }
        let raw = if raw.len() > 50_000 {
            format!("{}\n\n... (truncated at 50KB)", &raw[..50_000])
        } else {
            raw
        };
        // Non-hunk diffs have a distinct viewerJson partial-preview rule; retain TS there.
        if !raw.is_empty() && !raw.split(['\n', '\r']).any(|s| s.starts_with("@@ -")) {
            return Err(());
        }
        let diff = if raw.is_empty() {
            raw
        } else {
            git_diff::sanitize_commit(root, &raw, policy)?
        };
        let additions: u64 = files.iter().filter_map(|f| f["additions"].as_u64()).sum();
        let deletions: u64 = files.iter().filter_map(|f| f["deletions"].as_u64()).sum();
        let body = json!({"commit":{"hash":fields[0],"shortHash":fields[0].get(..7).ok_or(())?,"subject":fields[1],"body":fields[5..].join("\n").trim(),"author":fields[2],"email":fields[3],"date":fields[4],"files":files,"totalAdditions":additions,"totalDeletions":deletions,"stat":stat.trim(),"diff":diff}});
        let safe = policy.json(body, &[diff])?;
        Ok(reply(StatusCode::OK, safe))
    })();
    result.unwrap_or_else(|_| unavailable())
}
