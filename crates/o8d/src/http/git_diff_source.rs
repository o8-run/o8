use super::*;
fn blob_source(root: &str, id: &str, path: Option<&str>, new: bool) -> Result<Option<String>, ()> {
    if id.bytes().all(|b| b == b'0') {
        return Ok(Some(String::new()));
    }
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(());
    }
    if let Ok(text) = git(root, &["cat-file", "blob", id], 5000, 2 * 1024 * 1024) {
        return Ok(if text.contains('\0') {
            None
        } else {
            Some(text)
        });
    }
    if !new {
        return Ok(None);
    }
    let Some(path) = path else {
        return Ok(None);
    };
    let Ok(bytes) = source(root, path) else {
        return Ok(None);
    };
    if bytes.contains(&0) {
        return Ok(None);
    }
    let mut object = format!("blob {}\0", bytes.len()).into_bytes();
    object.extend_from_slice(&bytes);
    if !format!("{:x}", sha1::Sha1::digest(&object)).starts_with(id)
        && !format!("{:x}", Sha256::digest(&object)).starts_with(id)
    {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}
pub(super) fn sanitize(root: &str, diff: &str, policy: &ViewerRedaction) -> Result<String, ()> {
    let mut starts: Vec<usize> = diff
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || diff.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .collect();
    if starts.first() != Some(&0) {
        starts.insert(0, 0);
    }
    starts.push(diff.len());
    let mut out = String::new();
    for pair in starts.windows(2) {
        let section = &diff[pair[0]..pair[1]];
        if !section.lines().any(|s| s.starts_with("@@ -")) {
            out.push_str(section);
            continue;
        }
        let lines: Vec<_> = section.split('\n').collect();
        let id = lines
            .iter()
            .find_map(|s| s.strip_prefix("index "))
            .and_then(|s| s.split_whitespace().next())
            .ok_or(())?;
        let (old_id, new_id) = id.split_once("..").ok_or(())?;
        let path = |prefix| {
            lines
                .iter()
                .find_map(|s| s.strip_prefix(prefix))
                .and_then(|s| if s.starts_with('"') { None } else { s.get(2..) })
        };
        let old = blob_source(root, old_id, path("--- "), false)?;
        let next = blob_source(root, new_id, path("+++ "), true)?;
        let (Some(old), Some(next)) = (old, next) else {
            out.push_str("[redacted]\n");
            continue;
        };
        let before = policy.source_lines(&old)?;
        let after = policy.source_lines(&next)?;
        let (mut old_line, mut new_line, mut old_remaining, mut new_remaining) =
            (0usize, 0usize, 0usize, 0usize);
        let mut in_hunk = false;
        let mut valid = true;
        let mut result = Vec::new();
        for line in lines {
            if line.starts_with("@@ -") {
                if old_remaining != 0 || new_remaining != 0 {
                    valid = false;
                    break;
                }
                let Some(end) = line[3..].find(" @@").map(|i| i + 3) else {
                    return Err(());
                };
                let mut ranges = line[3..end].split(' ');
                let parse = |raw: Option<&str>| -> Result<(usize, usize), ()> {
                    let raw = raw.ok_or(())?.get(1..).ok_or(())?;
                    let (start, count) = raw.split_once(',').unwrap_or((raw, "1"));
                    Ok((
                        start.parse::<usize>().map_err(|_| ())?.saturating_sub(1),
                        count.parse().map_err(|_| ())?,
                    ))
                };
                (old_line, old_remaining) = parse(ranges.next())?;
                (new_line, new_remaining) = parse(ranges.next())?;
                in_hunk = true;
                result.push(line[..end + 3].to_owned());
                continue;
            }
            if !in_hunk || line.starts_with("\\ No newline") || line.is_empty() {
                result.push(line.to_owned());
                continue;
            }
            let prefix = line.as_bytes()[0];
            let value = &line[1..];
            let uses_old = prefix == b'-' || prefix == b' ';
            let uses_new = prefix == b'+' || prefix == b' ';
            if (!uses_old && !uses_new)
                || (uses_old
                    && (old_remaining == 0 || before.get(old_line).is_none_or(|v| v.0 != value)))
                || (uses_new
                    && (new_remaining == 0 || after.get(new_line).is_none_or(|v| v.0 != value)))
            {
                valid = false;
                break;
            }
            let secret = uses_old && before[old_line].1 || uses_new && after[new_line].1;
            result.push(if secret {
                format!("{}[redacted]", prefix as char)
            } else {
                line.to_owned()
            });
            if uses_old {
                old_line += 1;
                old_remaining -= 1;
            }
            if uses_new {
                new_line += 1;
                new_remaining -= 1;
            }
        }
        if !valid || old_remaining != 0 || new_remaining != 0 {
            out.push_str("[redacted]\n");
        } else {
            out.push_str(&result.join("\n"));
        }
    }
    Ok(out)
}
