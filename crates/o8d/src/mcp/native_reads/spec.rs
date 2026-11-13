use super::*;
use std::io::Read;

// Keep missing-file reads side-effect free. This is the canonical route's template.
const DEFAULT_TEMPLATE: &str = "# o8 Spec\n\n> One-page spec for this repo. Operator edits here. Agents read this on\n> dispatch and can write back when they need to record a decision.\n\n## Mission\n\nWhat this repo exists to do, in one paragraph.\n\n## Active scope\n\n- [ ] Goal you're working on right now\n- [ ] Next thing after that\n\n## Constraints\n\n- Hard rules the orchestrator must respect.\n\n## Open questions\n\n- Things you want surfaced for the operator before action.\n";

fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

pub(super) fn read(
    db: &Connection,
    args: &Value,
    policy: &Value,
    directory: &std::path::Path,
) -> ReadResult<Value> {
    // ECMAScript WhiteSpace + LineTerminator, exactly String.prototype.trim.
    let repo = PathBuf::from(string(args, "repoPath")?.trim_matches(|c| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}')
    }));
    if !repo.is_absolute()
        || fs::canonicalize(&repo).map_err(|_| ())?.as_os_str() != repo.as_os_str()
        || !repo.is_dir()
    {
        return Err(());
    }
    let path = repo.join("o8.md");
    let path_text = path.to_str().ok_or(())?;
    let captured = state(db, &format!("o8d/mcp/v1/spec/{}", digest(path_text)))?;
    let response = &captured["response"];
    // The canonical writer owns the response shape and viewer inspection. Never
    // manufacture an empty marks envelope for text read directly from disk.
    let mut environment: Vec<_> = std::env::vars_os()
        .map(|(key, value)| {
            Ok((
                key.into_string().map_err(|_| ())?,
                value.into_string().map_err(|_| ())?,
            ))
        })
        .collect::<ReadResult<_>>()?;
    environment.sort_by(|a, b| a.0.cmp(&b.0));
    let files: Vec<Option<String>> = ["ws-token", "mobile-device-tokens"]
        .iter()
        .map(|name| fs::read_to_string(directory.join(name)).ok())
        .collect();
    if captured["generation"] != policy["generation"]
        || captured["base"] != policy["base"]
        || captured["environment"] != digest(serde_json::to_vec(&environment).map_err(|_| ())?)
        || captured["credentials"] != digest(serde_json::to_vec(&files).map_err(|_| ())?)
        || response["ok"] != true
        || response["path"] != path_text
        || response["redaction"]["version"] != 1
        || response["redaction"]["offsetEncoding"] != "utf-8"
        || !response["redaction"]["spans"].is_array()
    {
        return Err(());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let (content, exists) = match options.open(&path) {
        Ok(file) if file.metadata().map_err(|_| ())?.is_file() => {
            let mut content = Vec::new();
            file.take(16_001)
                .read_to_end(&mut content)
                .map_err(|_| ())?;
            if content.len() > 16_000 {
                return Err(());
            }
            (content, true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (DEFAULT_TEMPLATE.as_bytes().to_vec(), false)
        }
        _ => return Err(()), // File errors retain the route's current structured code.
    };
    if response["contentHash"] != digest(content) || response["exists"] != exists {
        return Err(());
    }
    Ok(response.clone())
}
