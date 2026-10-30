//! CriticMarkup projection and review index, matching O8SpecEditor's buildAll.
//! Canonical metadata and thread semantics follow Roughdraft RFM (MIT).
//! See ../../../../licenses/roughdraft-MIT.txt for upstream attribution/license.
use regex::Regex;
use std::{collections::HashMap, ops::Range, sync::LazyLock};
#[derive(Clone, Debug)]
pub(super) struct Note {
    pub id: String,
    pub kind: String,
    pub author: String,
    pub text: String,
    pub anchor: String,
    pub offset: usize,
    pub resolved: bool,
    pub replies: Vec<(String, String)>,
}
#[derive(Default)]
pub(super) struct Review {
    pub hidden: Vec<Range<usize>>,
    pub dots: Vec<usize>,
    pub anchors: Vec<Range<usize>>,
    pub adds: Vec<Range<usize>>,
    pub deletes: Vec<Range<usize>>,
    pub arrows: Vec<Range<usize>>,
    pub notes: Vec<Note>,
}
fn attrs(s: &str) -> HashMap<String, String> {
    static ATTR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"([A-Za-z0-9_-]+)="((?:\\.|[^"\\])*)""#).unwrap());
    ATTR.captures_iter(s)
        .map(|c| {
            (
                c[1].to_owned(),
                c[2].replace("\\\"", "\"").replace("\\\\", "\\"),
            )
        })
        .collect()
}
pub(super) fn parse(source: &str) -> Review {
    static ITEMS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)\{==.*?==\}|\{>>.*?<<\}(?:\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})?|\{\+\+.*?\+\+\}(?:\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})?|\{--.*?--\}(?:\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})?|\{~~.*?~>.*?~~\}(?:\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})?"#).unwrap()
    });
    static META: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"\{(?:id|by|at|re|status|resolved)="(?:\\.|[^"\\])*"(?:\s+[A-Za-z_]+="(?:\\.|[^"\\])*")*\}"#).unwrap()
    });
    let code = code_ranges(source);
    let mut out = Review::default();
    let mut replies = vec![];
    let mut previous_anchor: Option<(Range<usize>, String)> = None;
    for m in ITEMS.find_iter(source) {
        let item = m.as_str();
        let from = m.start();
        let in_code = code.iter().any(|r| r.contains(&from));
        if item.starts_with("{==") {
            let end = m.end() - 3;
            out.hidden.extend([from..from + 3, end..m.end()]);
            out.anchors.push(from + 3..end);
            if !in_code {
                previous_anchor = Some((from..m.end(), source[from + 3..end].into()));
            }
            continue;
        }
        let close = if item.starts_with("{>>") {
            "<<}"
        } else if item.starts_with("{++") {
            "++}"
        } else if item.starts_with("{--") {
            "--}"
        } else {
            "~~}"
        };
        let Some(end) = item.find(close).map(|p| from + p) else {
            continue;
        };
        let metadata = attrs(&source[end + 3..m.end()]);
        let comment = item.starts_with("{>>");
        let inner = &source[from + 3..end];
        let (text, anchor) = if comment {
            out.hidden.push(from..end + 3);
            (
                inner.to_owned(),
                previous_anchor
                    .as_ref()
                    .filter(|(range, _)| source[range.end..from].trim().is_empty())
                    .map(|(_, s)| s.clone())
                    .unwrap_or_default(),
            )
        } else {
            out.hidden.extend([from..from + 3, end..end + 3]);
            if item.starts_with("{~~") {
                let split = inner.find("~>").unwrap();
                out.deletes.push(from + 3..from + 3 + split);
                out.arrows.push(from + 3 + split..from + 5 + split);
                out.adds.push(from + 5 + split..end);
                (
                    source[from + 5 + split..end].into(),
                    source[from + 3..from + 3 + split].into(),
                )
            } else {
                if item.starts_with("{++") {
                    out.adds.push(from + 3..end)
                } else {
                    out.deletes.push(from + 3..end)
                };
                (inner.to_owned(), inner.to_owned())
            }
        };
        if m.end() > end + 3 {
            out.hidden.push(end + 3..m.end());
        }
        // The canonical index ignores fenced and inline code, while buildAll's
        // display projection intentionally follows classic's regex decoration.
        if comment && !metadata.contains_key("re") {
            out.dots.push(from);
        }
        if in_code {
            continue;
        }
        let author = metadata.get("by").cloned().unwrap_or_default();
        if let Some(parent) = metadata.get("re") {
            replies.push((parent.clone(), author, text));
            if let Some((range, _)) = previous_anchor.as_mut() {
                if range.end <= from && source[range.end..from].trim().is_empty() {
                    range.end = m.end();
                }
            }
            continue;
        }
        let id = metadata.get("id").cloned().unwrap_or_else(|| {
            format!(
                "{}-{}",
                if comment { "comment" } else { "suggestion" },
                source[..from].encode_utf16().count()
            )
        });
        let offset = if comment {
            previous_anchor
                .as_ref()
                .filter(|(r, _)| source[r.end..from].trim().is_empty())
                .map(|(r, _)| r.start)
                .unwrap_or(from)
        } else {
            from
        };
        if comment {
            if let Some((range, _)) = previous_anchor.as_mut() {
                if range.end <= from && source[range.end..from].trim().is_empty() {
                    range.end = m.end();
                }
            }
        }
        out.notes.push(Note {
            id,
            kind: if comment { "comment" } else { "suggestion" }.into(),
            author,
            text,
            anchor,
            offset,
            resolved: metadata.get("status").is_some_and(|s| s == "resolved"),
            replies: vec![],
        });
    }
    out.hidden.extend(META.find_iter(source).map(|m| m.range()));
    static HEADINGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#{1,6} +").unwrap());
    out.hidden
        .extend(HEADINGS.find_iter(source).map(|m| m.range()));
    for (parent, author, text) in replies {
        if let Some(note) = out.notes.iter_mut().find(|n| n.id == parent) {
            note.replies.push((author, text));
        }
    }
    out
}

// Port of rfm.ts matchFence/matchInlineCodeSpan. Display decorations still
// follow buildAll; only the actionable review index excludes code examples.
fn code_ranges(source: &str) -> Vec<Range<usize>> {
    let mut ranges = vec![];
    let mut fence: Option<(u8, usize, usize)> = None;
    let mut offset = 0;
    while offset < source.len() {
        if offset == 0 || source.as_bytes()[offset - 1] == b'\n' {
            let end = source[offset..]
                .find('\n')
                .map(|n| offset + n + 1)
                .unwrap_or(source.len());
            let line = &source.as_bytes()[offset..end];
            let indent = line
                .iter()
                .take_while(|b| matches!(b, b' ' | b'\t'))
                .count();
            if indent <= 3 {
                if let Some(&marker) = line.get(indent).filter(|b| matches!(b, b'`' | b'~')) {
                    let count = line[indent..].iter().take_while(|b| **b == marker).count();
                    if count >= 3 {
                        match fence {
                            None => {
                                fence = Some((marker, count, offset));
                                offset = end;
                                continue;
                            }
                            Some((kind, length, start)) if kind == marker && count >= length => {
                                ranges.push(start..end);
                                fence = None;
                                offset = end;
                                continue;
                            }
                            _ => {}
                        }
                    }
                }
            }
            if fence.is_some() {
                offset = end;
                continue;
            }
        }
        if source.as_bytes()[offset] == b'`' {
            let count = source.as_bytes()[offset..]
                .iter()
                .take_while(|b| **b == b'`')
                .count();
            if let Some(end) = source[offset + count..].find(&"`".repeat(count)) {
                let end = offset + count + end + count;
                ranges.push(offset..end);
                offset = end;
                continue;
            }
        }
        offset += source[offset..].chars().next().unwrap().len_utf8();
    }
    if let Some((_, _, start)) = fence {
        ranges.push(start..source.len());
    }
    ranges
}
