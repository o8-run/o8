//! Fresh directive files. Node retains project scope, initialization and writers.
use super::*;
use std::{cmp::Ordering, collections::HashMap};
const FILE_LIMIT: u64 = 2 * 1024 * 1024;
const TOTAL_LIMIT: usize = 16 * 1024 * 1024;
fn trim(s: &str) -> &str {
    chat_context_json::trim(s)
}
fn unquote(s: &str) -> &str {
    let s = s.strip_prefix(['\'', '"']).unwrap_or(s);
    s.strip_suffix(['\'', '"']).unwrap_or(s)
}
fn whitespace(c: char) -> bool {
    trim(&c.to_string()).is_empty()
}
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn boundary(s: &str) -> bool {
    s.chars().next().is_none_or(|c| !word(c))
}
fn front(text: &str) -> Option<(&str, &str)> {
    let after = text.strip_prefix("---")?.trim_start_matches(whitespace);
    let mut offset = 0;
    for line in after.split_inclusive('\n') {
        if line.starts_with("---") && trim(line.strip_prefix("---")?).is_empty() {
            return Some((&after[..offset], trim(&after[offset + line.len()..])));
        }
        offset += line.len();
    }
    None
}
fn list(raw: Option<&String>) -> Result<Vec<String>, ()> {
    let raw = trim(raw.map(String::as_str).unwrap_or(""));
    let raw = raw.strip_prefix('[').unwrap_or(raw);
    let raw = raw.strip_suffix(']').unwrap_or(raw);
    let mut out = Vec::new();
    for item in raw.split(',') {
        let item = unquote(trim(item));
        // Preserve Node's case folding by keeping unsupported Unicode in TS.
        if !item.is_ascii() {
            return Err(());
        }
        let item = item.to_ascii_lowercase();
        if !item.is_empty() && !out.contains(&item) {
            out.push(item);
        }
    }
    Ok(out)
}
fn priority(raw: Option<&String>) -> Result<Option<i64>, ()> {
    let raw = trim(raw.map(String::as_str).unwrap_or(""));
    let negative = raw.starts_with('-');
    let raw = raw.strip_prefix(['-', '+']).unwrap_or(raw);
    let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return Ok(None);
    }
    let n: f64 = digits.parse().map_err(|_| ())?;
    if !n.is_finite() {
        return Ok(None);
    }
    if n > 9_007_199_254_740_991.0 {
        return Err(());
    }
    Ok(Some(if negative { -(n as i64) } else { n as i64 }))
}
struct Parsed {
    summary: Value,
    ids: Vec<String>,
}
fn parse(raw: &str, fallback: &str) -> Result<Parsed, ()> {
    let raw = raw.replace("\r\n", "\n");
    if raw.contains(['\r', '\u{2028}', '\u{2029}']) {
        return Err(());
    }
    let (front, body) = front(trim(&raw)).ok_or(())?;
    let mut meta = HashMap::new();
    for line in front.split('\n') {
        let Some((key, value)) = line.split_once(':') else {
            if !trim(line).is_empty() && !trim(line).starts_with('#') {
                return Err(());
            }
            continue;
        };
        let key = trim(key);
        if key.is_empty() {
            continue;
        }
        if ![
            "id",
            "title",
            "scope",
            "repoName",
            "projects",
            "projectIds",
            "projectId",
            "priority",
            "created",
            "updated",
            "history",
        ]
        .contains(&key)
        {
            return Err(());
        }
        meta.insert(key.to_owned(), unquote(trim(value)).to_owned());
    }
    let value = |key| trim(meta.get(key).map(String::as_str).unwrap_or(""));
    let id = if value("id").is_empty() {
        fallback
    } else {
        value("id")
    };
    // TS's trailer map is a plain object; inherited keys are unsupported.
    if [
        "__proto__",
        "constructor",
        "toString",
        "toLocaleString",
        "valueOf",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
    ]
    .contains(&id)
    {
        return Err(());
    }
    let title = if value("title").is_empty() {
        fallback
    } else {
        value("title")
    };
    // Exact English default collation subset; punctuation/Unicode titles defer.
    if !title.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ') {
        return Err(());
    }
    let scope = if value("scope").is_empty() {
        "global"
    } else {
        value("scope")
    };
    let repo = value("repoName");
    if !scope.is_ascii() || !repo.is_ascii() {
        return Err(());
    }
    let mut cut = body.len();
    for (index, _) in body.match_indices("##") {
        let rest = &body[index + 2..];
        let after = rest.trim_start_matches(whitespace);
        if after.len() != rest.len() && after.strip_prefix("Recent Merges").is_some_and(boundary) {
            cut = index;
            break;
        }
    }
    Ok(Parsed {
        ids: list(meta.get("projectIds").or_else(|| meta.get("projectId")))?,
        summary: json!({"id":id,"title":title,"scope":scope,"repoName":if repo.is_empty(){None}else{Some(repo)},"priority":priority(meta.get("priority"))?,"body":trim(&body[..cut]),"projects":list(meta.get("projects"))?,"recentMerges":[],"file":null}),
    })
}
fn trailers(raw: &str, fallback: &str) -> (String, Vec<String>) {
    let raw = raw.replace("\r\n", "\n");
    // This parser intentionally does not trim or unquote the id, unlike parse().
    let mut id = fallback.to_owned();
    if let Some((front, _)) = front(&raw) {
        for line in front.split('\n') {
            if let Some((key, value)) = line.split_once(':') {
                if trim(key) == "id" {
                    id = if trim(value).is_empty() {
                        fallback
                    } else {
                        trim(value)
                    }
                    .to_owned();
                }
            }
        }
    }
    let mut found = None;
    for (index, _) in raw.match_indices("## Recent Merges") {
        if (index == 0 || raw.as_bytes()[index - 1] == b'\n') && boundary(&raw[index + 16..]) {
            found = Some(index + 16);
            break;
        }
    }
    let values = found
        .map(|start| {
            raw[start..]
                .trim_start_matches(whitespace)
                .split('\n')
                .map(trim)
                .filter(|s| s.starts_with("- "))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    (id, values.into_iter().rev().take(3).collect())
}
fn strings<'a>(scope: &'a Value, key: &str) -> Result<Vec<&'a str>, ()> {
    scope[key]
        .as_array()
        .ok_or(())?
        .iter()
        .map(|v| v.as_str().filter(|s| s.len() <= 1024).ok_or(()))
        .collect()
}
fn applies(parsed: &Parsed, scope: &Value, repo: Option<&str>) -> Result<bool, ()> {
    let kind = parsed.summary["scope"]
        .as_str()
        .ok_or(())?
        .to_ascii_lowercase();
    if kind == "global" || kind.is_empty() {
        return Ok(true);
    }
    if kind == "project" {
        if repo.is_some() && scope["repoInActiveProject"] != true {
            return Ok(false);
        }
        let ids = strings(scope, "projectIds")?;
        let slugs = strings(scope, "projectSlugs")?;
        return Ok(parsed.ids.iter().any(|id| ids.contains(&id.as_str()))
            || parsed.summary["projects"]
                .as_array()
                .ok_or(())?
                .iter()
                .any(|slug| slug.as_str().is_some_and(|slug| slugs.contains(&slug))));
    }
    let Some(repo) = repo else {
        return Ok(false);
    };
    Ok(kind == repo
        || parsed.summary["repoName"]
            .as_str()
            .is_some_and(|name| !name.is_empty() && name.to_ascii_lowercase() == repo))
}
fn title_cmp(a: &str, b: &str) -> Ordering {
    a.to_ascii_lowercase()
        .cmp(&b.to_ascii_lowercase())
        .then_with(|| {
            a.bytes()
                .zip(b.bytes())
                .find_map(|(a, b)| {
                    if a == b {
                        None
                    } else {
                        Some(a.is_ascii_uppercase().cmp(&b.is_ascii_uppercase()))
                    }
                })
                .unwrap_or(Ordering::Equal)
        })
}
#[cfg(unix)]
fn stamp(path: &Path) -> Result<(u64, u64, u64, i64, i64, i64, i64), ()> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if m.file_type().is_symlink() {
        return Err(());
    }
    Ok((
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
#[cfg(not(unix))]
fn stamp(_: &Path) -> Result<(), ()> {
    Err(())
}
fn listing(root: &Path) -> Result<Vec<String>, ()> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|_| ())? {
        let entry = entry.map_err(|_| ())?;
        let name = entry.file_name().into_string().map_err(|_| ())?;
        if !name.ends_with(".md") {
            continue;
        }
        if !name.is_ascii() || !entry.file_type().map_err(|_| ())?.is_file() || names.len() >= 1024
        {
            return Err(());
        }
        names.push(name);
    }
    names.sort();
    Ok(names)
}
pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    let mut duration = None;
    let result = (|| -> ReadResult {
        let scope = &store.defaults_context.as_ref().ok_or(())?["directivesScope"];
        if scope["version"] != 1
            || !scope["directoryExists"].is_boolean()
            || serde_json::to_vec(scope).map_err(|_| ())?.len() > 2048
        {
            return Err(());
        }
        let root = store.directory.join("directives");
        match std::fs::symlink_metadata(&root) {
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && scope["directoryExists"] == false =>
            {
                return Ok(json!({"directives":[]}))
            }
            Ok(m)
                if m.is_dir()
                    && !m.file_type().is_symlink()
                    && scope["directoryExists"] == true =>
            {
                ()
            }
            _ => return Err(()),
        }
        if root.canonicalize().map_err(|_| ())? != root
            || !scope["repoInActiveProject"].is_boolean()
        {
            return Err(());
        }
        if strings(scope, "projectIds")?.len() + strings(scope, "projectSlugs")?.len() > 128 {
            return Err(());
        }
        let repo = trim(value(params, "repoPath"));
        let repo = if repo.is_empty() {
            None
        } else {
            let repo = repo.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            if !repo.is_ascii() {
                return Err(());
            }
            Some(repo.to_ascii_lowercase())
        };
        let before = stamp(&root)?;
        let started = std::time::Instant::now();
        let names = listing(&root)?;
        let mut all = Vec::new();
        let mut merges = HashMap::new();
        let mut sources = Vec::new();
        let mut identities = Vec::new();
        let mut total = 0;
        for name in &names {
            let file = root.join(name);
            let identity = stamp(&file)?;
            let opened = file_content::open_bytes(root.to_str().ok_or(())?, name, None, FILE_LIMIT)
                .map_err(|_| ())?;
            total += opened.bytes.len();
            if total > TOTAL_LIMIT {
                return Err(());
            }
            if stamp(&file)? != identity {
                return Err(());
            }
            let raw = String::from_utf8(opened.bytes).map_err(|_| ())?;
            let fallback = name.strip_suffix(".md").ok_or(())?;
            let mut parsed = parse(&raw, fallback)?;
            parsed.summary["file"] = json!(file.to_str().ok_or(())?);
            sources.push((fallback.to_owned(), raw));
            all.push(parsed);
            identities.push((file, identity));
        }
        duration = Some(started.elapsed().as_secs_f64() * 1000.0);
        for (fallback, raw) in sources {
            let (id, lines) = trailers(&raw, &fallback);
            if !lines.is_empty() {
                merges.insert(id, lines);
            }
        }
        let mut directives = Vec::new();
        for mut parsed in all {
            if applies(&parsed, scope, repo.as_deref())? {
                let id = parsed.summary["id"].as_str().ok_or(())?;
                parsed.summary["recentMerges"] = json!(merges.get(id).cloned().unwrap_or_default());
                directives.push(parsed.summary);
            }
        }
        directives.sort_by(|a, b| {
            b["priority"]
                .as_i64()
                .unwrap_or(0)
                .cmp(&a["priority"].as_i64().unwrap_or(0))
                .then_with(|| {
                    title_cmp(
                        a["title"].as_str().unwrap_or(""),
                        b["title"].as_str().unwrap_or(""),
                    )
                })
        });
        if listing(&root)? != names || stamp(&root)? != before {
            return Err(());
        }
        for (file, identity) in identities {
            if stamp(&file)? != identity {
                return Err(());
            }
        }
        let body = json!({"directives":directives});
        if serde_json::to_vec(&body).map_err(|_| ())?.len() > 7 * 1024 * 1024 {
            return Err(());
        }
        Ok(body)
    })();
    match result {
        Ok(body) => {
            let mut response = reply(StatusCode::OK, body);
            if let Some(duration) = duration {
                response.headers_mut().insert(
                    "x-o8d-directives-timing",
                    duration.to_string().parse().unwrap(),
                );
            }
            response
        }
        Err(()) => unavailable(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frontmatter_lists_bodies_and_distinct_trailer_ids_match() {
        let raw="---\r\nid: \"quoted\"\r\ntitle: Beta\r\nprojects: ['ONE', one, two]\r\npriority: -12tail\r\n---\r\nbody\r\n## Recent Merges\r\n- first\r\n- second\r\n";
        let parsed = parse(raw, "fallback").unwrap();
        assert_eq!(parsed.summary["id"], "quoted");
        assert_eq!(parsed.summary["body"], "body");
        assert_eq!(parsed.summary["projects"], json!(["one", "two"]));
        assert_eq!(parsed.summary["priority"], -12);
        assert_eq!(
            trailers(raw, "fallback"),
            (
                "\"quoted\"".to_owned(),
                vec!["- second".to_owned(), "- first".to_owned()]
            )
        );
        assert!(parse("not frontmatter", "fallback").is_err());
        assert!(parse("---\nunknown: []\n---\nbody", "fallback").is_err());
        assert_eq!(title_cmp("beta", "Beta"), Ordering::Less);
    }
}
