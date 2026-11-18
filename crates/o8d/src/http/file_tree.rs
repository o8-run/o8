//! Independent bounded TTL cache. No TypeScript cache access or invalidation coupling.
use super::*;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Mutex, OnceLock},
};
const IGNORE: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    ".turbo",
    "target",
    "dist",
    ".DS_Store",
    ".pnpm-store",
    ".cache",
];
const SHOW_DOT: &[&str] = &[
    ".github",
    ".vscode",
    ".claude",
    ".cursor",
    ".cortexrules",
    ".cursorrules",
    ".clinerules",
    ".env",
    ".env.local",
    ".env.example",
    ".env.development",
    ".env.production",
    ".env.test",
    ".gitignore",
    ".gitattributes",
    ".npmrc",
    ".nvmrc",
    ".node-version",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    ".prettierrc",
    ".prettierrc.js",
    ".editorconfig",
    ".dockerignore",
    ".tool-versions",
    "CLAUDE.md",
    "AGENTS.md",
];
struct Cached {
    root: String,
    body: String,
    bytes: usize,
    at: i64,
}
fn cache() -> &'static Mutex<VecDeque<Cached>> {
    static CACHE: OnceLock<Mutex<VecDeque<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}
fn cached(root: &str) -> Option<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut cache = cache().lock().ok()?;
    let index = cache
        .iter()
        .position(|c| c.root == root && now.saturating_sub(c.at) < 15_000)?;
    let entry = cache.remove(index)?;
    let body = serde_json::from_str(&entry.body).ok()?;
    cache.push_back(entry);
    Some(body)
}
fn save(root: &str, body: &Value) {
    let Ok(body) = serde_json::to_string(body) else {
        return;
    };
    let now = chrono::Utc::now().timestamp_millis();
    let bytes = (body.encode_utf16().count() + root.encode_utf16().count()) * 2;
    if bytes > 4 * 1024 * 1024 {
        return;
    }
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    cache.retain(|c| c.root != root && now.saturating_sub(c.at) < 15_000);
    while cache.len() >= 32
        || cache.iter().map(|c| c.bytes).sum::<usize>() + bytes > 4 * 1024 * 1024
    {
        cache.pop_front();
    }
    cache.push_back(Cached {
        root: root.to_owned(),
        body,
        bytes,
        at: now,
    });
}
struct Entry {
    name: String,
    dir: bool,
    file: bool,
}
fn entries(path: &Path) -> Result<Vec<Entry>, ()> {
    let raw = std::fs::read_dir(path).map_err(|_| ())?;
    let mut entries = Vec::new();
    for entry in raw {
        let entry = entry.map_err(|_| ())?;
        let name = entry.file_name().into_string().map_err(|_| ())?;
        let kind = entry.file_type().map_err(|_| ())?;
        entries.push(Entry {
            name,
            dir: kind.is_dir(),
            file: kind.is_file(),
        });
    }
    // ASCII letter case, punctuation and locale-sensitive names need ICU parity.
    if entries.len() > 1
        && entries.iter().any(|e| {
            !e.name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        })
    {
        return Err(());
    }
    // ICU's default English punctuation order differs from byte order for '_'.
    let rank = |byte| match byte {
        b'_' => 0,
        b'-' => 1,
        b'.' => 2,
        other => other,
    };
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.bytes().map(rank).cmp(b.name.bytes().map(rank)))
    });
    Ok(entries)
}
fn visible(name: &str, dir: bool) -> bool {
    !name.starts_with('.') || SHOW_DOT.contains(&name) || (dir && IGNORE.contains(&name))
}
fn tree(root: &Path, rel: &str, depth: usize) -> ReadResult {
    if depth > 3 {
        return Ok(json!([]));
    }
    let list = match entries(&root.join(rel)) {
        Ok(v) => v,
        Err(()) => {
            if !root.join(rel).is_dir() {
                return Ok(json!([]));
            }
            return Err(());
        }
    };
    let mut nodes = Vec::new();
    for entry in list {
        if IGNORE.contains(&entry.name.as_str())
            || (entry.name.starts_with('.') && !SHOW_DOT.contains(&entry.name.as_str()))
        {
            continue;
        }
        let path = if rel.is_empty() {
            entry.name.clone()
        } else {
            format!("{rel}/{}", entry.name)
        };
        nodes.push(if entry.dir {
            json!({"name":entry.name,"path":path,"type":"dir","children":tree(root,&path,depth+1)?})
        } else {
            json!({"name":entry.name,"path":path,"type":"file"})
        });
    }
    Ok(json!(nodes))
}
fn flat(root: &Path) -> Result<Vec<Value>, ()> {
    let mut files = Vec::new();
    let mut pending = VecDeque::from([String::new()]);
    while let Some(rel) = pending.pop_front() {
        if files.len() >= 20_000 {
            break;
        }
        let list = match entries(&root.join(&rel)) {
            Ok(v) => v,
            Err(()) => {
                if root.join(&rel).is_dir() {
                    return Err(());
                }
                continue;
            }
        };
        for entry in list {
            if (!entry.dir && !entry.file) || !visible(&entry.name, entry.dir) {
                continue;
            }
            let path = if rel.is_empty() {
                entry.name.clone()
            } else {
                format!("{rel}/{}", entry.name)
            };
            if entry.dir {
                if !IGNORE.contains(&entry.name.as_str()) {
                    pending.push_back(path);
                }
            } else {
                files.push(json!({"name":entry.name,"path":path,"kind":"file"}));
                if files.len() >= 20_000 {
                    break;
                }
            }
        }
    }
    Ok(files)
}
pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    let result = (|| -> Result<Response, ()> {
        store.redaction.as_ref().ok_or(())?;
        let ctx = store.defaults_context.as_ref().ok_or(())?;
        if !ctx
            .get("filesTreeRoot")
            .is_some_and(|value| value.is_null() || value.is_string())
        {
            return Err(());
        }
        if !matches!(ctx["fileTreeLocale"].as_str(), Some("en" | "en-US")) {
            return Err(());
        }
        let raw = params
            .get("workspace")
            .filter(|s| !s.is_empty())
            .map(String::as_str)
            .or_else(|| ctx["filesTreeRoot"].as_str());
        let Some(raw) = raw else {
            return Ok(bounded_reply(
                StatusCode::OK,
                json!({"tree":[],"root":null,"changedFiles":[]}),
            ));
        };
        let home = ctx["projectsHome"].as_str().ok_or(())?;
        let root = raw
            .strip_prefix('~')
            .map(|s| format!("{home}{s}"))
            .unwrap_or_else(|| raw.to_owned());
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
        if let Some(query) = params.get("search") {
            let query = query.trim();
            if !query.is_ascii() {
                return Err(());
            }
            let query = &query[..query.len().min(256)];
            if query.is_empty() {
                return Ok(bounded_reply(
                    StatusCode::OK,
                    json!({"entries":[],"truncated":false}),
                ));
            }
            if !repository::supports_native_projection(&root) {
                return Err(());
            }
            let paths = match repository::git(
                &root,
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
                2000,
                4_000_000,
            ) {
                Ok(raw) => {
                    let mut seen = HashSet::new();
                    raw.split('\0')
                        .filter(|s| !s.is_empty())
                        .filter(|s| seen.insert(s.to_string()))
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                }
                Err(()) => flat(root_path)?
                    .into_iter()
                    .filter_map(|v| v["path"].as_str().map(str::to_owned))
                    .collect(),
            };
            let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
            let matches: Vec<_> = paths
                .into_iter()
                .filter(|path| terms.iter().all(|term| path.to_lowercase().contains(term)))
                .collect();
            let values:Vec<_>=matches.iter().take(500).map(|path|json!({"name":Path::new(path).file_name().map(|s|s.to_string_lossy()),"path":path,"kind":"file"})).collect();
            return Ok(bounded_reply(
                StatusCode::OK,
                json!({"entries":values,"truncated":matches.len()>500}),
            ));
        }
        // Directory listings need git check-ignore stdin semantics; keep that variant in TS.
        if params.contains_key("directory") {
            return Err(());
        }
        if value(params, "recursive") == "files" {
            let entries = flat(root_path)?;
            return Ok(bounded_reply(
                StatusCode::OK,
                json!({"truncated":entries.len()>=20_000,"entries":entries,"root":root}),
            ));
        }
        if let Some(body) = cached(&root) {
            return Ok(bounded_reply(StatusCode::OK, body));
        }
        if !repository::supports_native_projection(&root) {
            return Err(());
        }
        let tree = tree(root_path, "", 0)?;
        let changes = repository::git(&root, &["status", "--porcelain"], 5000, 16 * 1024 * 1024)
            .unwrap_or_default();
        let mut seen = HashSet::new();
        let changed: Vec<_> = changes
            .lines()
            .filter_map(|line| line.get(3..))
            .filter_map(|path| path.split(" -> ").next())
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .filter(|path| seen.insert(path.to_string()))
            .collect();
        let body = json!({"tree":tree,"root":root,"changedFiles":changed});
        save(&root, &body);
        Ok(bounded_reply(StatusCode::OK, body))
    })();
    result.unwrap_or_else(|_| unavailable())
}

fn bounded_reply(status: StatusCode, body: Value) -> Response {
    if serde_json::to_vec(&body).map_or(true, |bytes| bytes.len() > RESPONSE_LIMIT) {
        return unavailable();
    }
    super::reply(status, body)
}
