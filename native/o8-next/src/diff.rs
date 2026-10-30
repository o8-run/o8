//! Read-only Git patch model. Parsing/highlighting happen off the GPUI thread.
use crate::client::Client;
use crate::theme::current as theme;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{ops::Range, sync::LazyLock};
use tree_sitter::{Language, Node, Parser};

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Packet(String),
    Worktree {
        path: String,
        base: Option<String>,
        file: Option<String>,
    },
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub diff: String,
    #[serde(default)]
    pub head_sha: String,
    #[serde(default)]
    pub truncated: bool,
    pub error: Option<Value>,
    pub revision: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Context,
    Added,
    Removed,
    Hunk,
    Meta,
}
#[derive(Debug)]
pub struct Line {
    pub kind: Kind,
    pub old: Option<usize>,
    pub new: Option<usize>,
    pub text: String,
    pub highlights: Vec<(Range<usize>, gpui::Rgba)>,
}
#[derive(Default, Debug)]
pub struct File {
    pub path: String,
    pub old_path: String,
    pub status: String,
    pub lines: Vec<Line>,
    pub split: Vec<(Option<usize>, Option<usize>)>,
    pub additions: usize,
    pub deletions: usize,
    pub width_chars: usize,
}
#[derive(Default, Debug)]
pub struct Document {
    pub files: Vec<File>,
    pub head: String,
    pub truncated: bool,
    pub revision: Option<String>,
    pub source: String,
    pub unsupported: bool,
}
impl Target {
    pub fn read(&self, client: &Client) -> Result<(Document, Value), String> {
        let response: Response = match self {
            Self::Packet(packet) => {
                // Packet ids occupy exactly one path segment.
                let id: String = url::form_urlencoded::byte_serialize(packet.as_bytes()).collect();
                client.get(&format!("/api/lanes/{id}/diff"), &[("maxBytes", "524288")])?
            }
            Self::Worktree { path, base, file } => {
                let mut query = vec![("worktreePath", path.as_str())];
                if let Some(base) = base {
                    query.push(("baseBranch", base));
                }
                if let Some(file) = file {
                    query.push(("file", file));
                }
                client.get("/api/worktrees/diff", &query)?
            }
        };
        if response.error.is_some() {
            return Err("Diff unavailable. Refresh the selected target.".into());
        }
        if response.head_sha.len() != 40
            || !response.head_sha.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Diff has no verifiable HEAD. Review is disabled.".into());
        }
        let state = match self {
            Self::Packet(id) => client.review_state(id)?,
            _ => Value::Null,
        };
        let mut document = parse(&response.diff);
        document.head = response.head_sha;
        document.truncated = response.truncated;
        document.revision = response.revision;
        document.source = response.diff;
        Ok((document, state))
    }
}

/// Git quotes unusual paths using C-style octal UTF-8, not JSON escaping.
fn path(source: &str) -> String {
    let source = source.trim_end_matches('\r');
    if !source.starts_with('"') {
        return source.into();
    }
    let mut bytes = vec![];
    let mut source = source
        .strip_prefix('"')
        .unwrap_or(source)
        .strip_suffix('"')
        .unwrap_or(source)
        .bytes()
        .peekable();
    while let Some(b) = source.next() {
        if b != b'\\' {
            bytes.push(b);
            continue;
        }
        let Some(b) = source.next() else {
            break;
        };
        if (b'0'..=b'7').contains(&b) {
            let mut number = (b - b'0') as u16;
            for _ in 0..2 {
                if let Some(b'0'..=b'7') = source.peek() {
                    number = number * 8 + (source.next().unwrap() - b'0') as u16;
                }
            }
            bytes.push(number as u8);
        } else {
            bytes.push(match b {
                b't' => b'\t',
                b'n' => b'\n',
                b'r' => b'\r',
                other => other,
            });
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}
fn file_path(source: &str) -> String {
    let value = path(source.split('\t').next().unwrap_or(source));
    value
        .strip_prefix("a/")
        .or_else(|| value.strip_prefix("b/"))
        .unwrap_or(&value)
        .into()
}

pub fn parse(patch: &str) -> Document {
    static HUNK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap());
    let mut document = Document::default();
    let mut old = 0;
    let mut new = 0;
    let mut in_hunk = false;
    let mut remaining = (0usize, 0usize);
    for source in patch.lines() {
        if let Some(header) = source.strip_prefix("diff --git ") {
            document.unsupported |= remaining != (0, 0);
            let (left, right) = if header.starts_with('"') {
                let mut escaped = false;
                let end = header
                    .char_indices()
                    .skip(1)
                    .find_map(|(i, c)| {
                        if escaped {
                            escaped = false;
                            return None;
                        }
                        if c == '\\' {
                            escaped = true;
                            return None;
                        }
                        (c == '"').then_some(i + 1)
                    })
                    .unwrap_or(header.len());
                (&header[..end], header[end..].trim_start())
            } else {
                let at = header.rfind(" b/").unwrap_or(header.len());
                (&header[..at], header[at..].trim_start())
            };
            document.files.push(File {
                status: "modified".into(),
                old_path: file_path(left),
                path: file_path(right),
                ..File::default()
            });
            in_hunk = false;
            continue;
        }
        let Some(file) = document.files.last_mut() else {
            document.unsupported |= !source.trim().is_empty();
            continue;
        };
        let mut add = |kind, text: &str, old, new| {
            file.lines.push(Line {
                kind,
                text: text.into(),
                old,
                new,
                highlights: vec![],
            })
        };
        if let Some(captures) = HUNK.captures(source) {
            document.unsupported |= remaining != (0, 0);
            old = captures[1].parse().unwrap_or(0);
            new = captures[3].parse().unwrap_or(0);
            remaining = (
                captures
                    .get(2)
                    .map_or(1, |m| m.as_str().parse().unwrap_or(0)),
                captures
                    .get(4)
                    .map_or(1, |m| m.as_str().parse().unwrap_or(0)),
            );
            in_hunk = true;
            add(Kind::Hunk, source, None, None);
        } else if in_hunk {
            match source.as_bytes().first() {
                Some(b'+') => {
                    document.unsupported |= remaining.1 == 0;
                    remaining.1 = remaining.1.saturating_sub(1);
                    add(Kind::Added, &source[1..], None, Some(new));
                    new += 1;
                    file.additions += 1;
                }
                Some(b'-') => {
                    document.unsupported |= remaining.0 == 0;
                    remaining.0 = remaining.0.saturating_sub(1);
                    add(Kind::Removed, &source[1..], Some(old), None);
                    old += 1;
                    file.deletions += 1;
                }
                Some(b' ') => {
                    document.unsupported |= remaining.0 == 0 || remaining.1 == 0;
                    remaining = (remaining.0.saturating_sub(1), remaining.1.saturating_sub(1));
                    add(Kind::Context, &source[1..], Some(old), Some(new));
                    old += 1;
                    new += 1;
                }
                Some(b'\\') => add(Kind::Meta, source, None, None),
                _ => document.unsupported |= !source.is_empty(),
            }
        } else if let Some(value) = source.strip_prefix("--- ") {
            let value = file_path(value);
            if value != "/dev/null" {
                file.old_path = value.clone();
                if file.path.is_empty() {
                    file.path = value;
                }
            }
        } else if let Some(value) = source.strip_prefix("+++ ") {
            let value = file_path(value);
            if value != "/dev/null" {
                file.path = value;
            }
        } else if let Some(value) = source.strip_prefix("rename from ") {
            add(Kind::Meta, source, None, None);
            file.old_path = path(value);
            file.status = "renamed".into();
        } else if let Some(value) = source.strip_prefix("rename to ") {
            add(Kind::Meta, source, None, None);
            file.path = path(value);
            file.status = "renamed".into();
        } else if source.starts_with("new file mode") {
            add(Kind::Meta, source, None, None);
            file.status = "added".into();
        } else if source.starts_with("deleted file mode") {
            add(Kind::Meta, source, None, None);
            file.status = "deleted".into();
        } else if [
            "old mode ",
            "new mode ",
            "index ",
            "similarity index ",
            "dissimilarity index ",
            "copy from ",
            "copy to ",
        ]
        .iter()
        .any(|prefix| source.starts_with(prefix))
        {
            add(Kind::Meta, source, None, None);
        } else if source.starts_with("Binary files ") || source == "GIT binary patch" {
            add(Kind::Meta, "Binary file · preview unavailable", None, None);
        } else {
            document.unsupported |= !source.trim().is_empty();
        }
    }
    document.unsupported |= remaining != (0, 0);
    for file in &mut document.files {
        document.unsupported |= file.path.is_empty();
        if file.lines.is_empty() {
            file.lines.push(Line {
                kind: Kind::Meta,
                text: if file.status == "renamed" {
                    format!("{} → {}", file.old_path, file.path)
                } else {
                    "Metadata-only change".into()
                },
                old: None,
                new: None,
                highlights: vec![],
            });
        }
        file.width_chars = file
            .lines
            .iter()
            .map(|line| line.text.chars().count())
            .max()
            .unwrap_or(0);
        // Pair adjacent removed/added blocks once. Switching views never rebuilds rows.
        let mut i = 0;
        while i < file.lines.len() {
            if file.lines[i].kind == Kind::Removed {
                let start = i;
                while i < file.lines.len() && file.lines[i].kind == Kind::Removed {
                    i += 1;
                }
                let added = i;
                while i < file.lines.len() && file.lines[i].kind == Kind::Added {
                    i += 1;
                }
                for n in 0..(added - start).max(i - added) {
                    file.split.push((
                        (start + n < added).then_some(start + n),
                        (added + n < i).then_some(added + n),
                    ));
                }
            } else {
                file.split.push(match file.lines[i].kind {
                    Kind::Added => (None, Some(i)),
                    _ => (Some(i), Some(i)),
                });
                i += 1;
            }
        }
        highlight(file);
    }
    document
}

fn language(path: &str) -> Option<Language> {
    match path.rsplit('.').next()? {
        "ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        "md" | "markdown" => Some(tree_sitter_md::LANGUAGE.into()),
        "json" => Some(tree_sitter_json::LANGUAGE.into()),
        _ => None,
    }
}
// Original palette mapping over the permissively licensed grammar trees. Source
// bytes remain unchanged; style spans are clipped to each displayed UTF-8 line.
fn color(node: Node) -> Option<gpui::Rgba> {
    let kind = node.kind();
    if kind.contains("comment") {
        Some(theme().text_secondary)
    } else if kind.contains("string") || kind == "char_literal" {
        Some(theme().syntax_string)
    } else if kind.contains("heading") || kind.starts_with("atx_h") || kind.contains("link") {
        Some(theme().syntax_link)
    } else if kind.contains("emphasis")
        || kind.contains("code_span")
        || kind.contains("code_fence")
        || kind == "list_marker_minus"
    {
        Some(theme().syntax_emphasis)
    } else if kind.contains("type") || kind == "type_identifier" {
        Some(theme().syntax_keyword)
    } else if kind.contains("integer") || kind.contains("float") || kind == "number" {
        Some(theme().syntax_emphasis)
    } else if [
        "export", "const", "let", "var", "function", "return", "fn", "pub", "use", "impl",
        "struct", "enum", "if", "else", "match", "for", "while", "async", "await", "true", "false",
        "null",
    ]
    .contains(&kind)
    {
        Some(theme().syntax_keyword)
    } else {
        None
    }
}
fn visit(node: Node, source: &str, spans: &mut Vec<(Range<usize>, gpui::Rgba)>) {
    if let Some(color) = color(node) {
        spans.push((node.byte_range(), color));
        return;
    }
    if node.kind() == "inline" && node.parent().is_some() {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_md::INLINE_LANGUAGE.into())
            .unwrap();
        if let Some(tree) = parser.parse(&source[node.byte_range()], None) {
            let mut inline = vec![];
            visit(tree.root_node(), &source[node.byte_range()], &mut inline);
            spans.extend(inline.into_iter().map(|(range, color)| {
                (
                    (range.start + node.start_byte())..(range.end + node.start_byte()),
                    color,
                )
            }));
        }
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, source, spans);
    }
}
fn highlight(file: &mut File) {
    let Some(language) = language(&file.path) else {
        return;
    };
    // Parse each side independently: removed code cannot poison added-code state.
    for before in [true, false] {
        let mut source = String::new();
        let mut offsets = vec![];
        for (i, line) in file.lines.iter().enumerate() {
            if matches!(line.kind, Kind::Hunk | Kind::Meta)
                || (before && line.kind == Kind::Added)
                || (!before && line.kind == Kind::Removed)
            {
                continue;
            }
            offsets.push((i, source.len(), line.text.len()));
            source.push_str(&line.text);
            source.push('\n');
        }
        let mut parser = Parser::new();
        if parser.set_language(&language).is_err() {
            continue;
        }
        let Some(tree) = parser.parse(&source, None) else {
            continue;
        };
        let mut spans = vec![];
        visit(tree.root_node(), &source, &mut spans);
        let mut first = 0;
        for (index, offset, len) in offsets {
            while first < spans.len() && spans[first].0.end <= offset {
                first += 1;
            }
            let line = &mut file.lines[index];
            // Context is styled from the new side, once.
            if !before {
                line.highlights.clear();
            }
            for (span, color) in spans[first..]
                .iter()
                .take_while(|(span, _)| span.start < offset + len)
            {
                let start = span.start.max(offset) - offset;
                let end = span.end.min(offset + len) - offset;
                if start < end {
                    line.highlights.push((start..end, *color));
                }
            }
        }
    }
}

/// Syntax spans for a complete source file, using the diff viewer's grammar and
/// semantic palette. Call off the UI thread; unsupported languages stay plain.
pub fn highlight_source(
    path: &str,
    source: &str,
) -> Result<Option<Vec<(Range<usize>, gpui::Rgba)>>, String> {
    let Some(language) = language(path) else {
        return Ok(None);
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|_| "Syntax colors are unavailable.")?;
    let tree = parser
        .parse(source, None)
        .ok_or("Syntax colors are unavailable.")?;
    let mut spans = vec![];
    visit(tree.root_node(), source, &mut spans);
    Ok(Some(spans))
}

pub fn decision(packet: &str, head: &str, approved: bool) -> Value {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    json!({"packetId":packet,"reviewedHeadSha":head,"approved":approved,"findings":[],
        "clientMutationId":format!("next-review-{}-{nonce}", std::process::id())})
}
