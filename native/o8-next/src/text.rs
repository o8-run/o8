//! Small read-only renderer matching the web transcript's line-oriented grammar.
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{LazyLock, RwLock},
};

fn re(pattern: &str) -> Regex {
    static CACHE: LazyLock<RwLock<HashMap<String, Regex>>> =
        LazyLock::new(|| RwLock::new(HashMap::new()));
    if let Some(regex) = CACHE.read().unwrap().get(pattern) {
        return regex.clone();
    }
    let regex = Regex::new(pattern).expect("constant pattern");
    CACHE.write().unwrap().insert(pattern.into(), regex.clone());
    regex
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Run {
    #[serde(serialize_with = "wire_style")]
    pub style: String,
    pub text: String,
}
/// A link's target is native-only; the recorded tree keeps the web's style name.
fn wire_style<S: serde::Serializer>(style: &str, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(if style.starts_with("link") {
        "link"
    } else {
        style
    })
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Node {
    /// Native layout metadata; the recorded render tree stays wire-compatible.
    #[serde(skip)]
    pub fence_closed: bool,
    pub kind: String,
    pub runs: Vec<Run>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}
impl Node {
    pub fn notice(text: &str) -> Self {
        Self {
            fence_closed: false,
            kind: "notice".into(),
            runs: vec![Run {
                style: "text".into(),
                text: text.into(),
            }],
            language: None,
            data: None,
        }
    }
}

pub fn sanitize(text: &str) -> String {
    let mut text = text.to_owned();
    if re(r"(?i)<(?:status|summary|task|source|action)>").is_match(&text) {
        let capture = |tag: &str| {
            re(&format!(r"(?is)<{tag}>(.*?)</{tag}>"))
                .captures(&text)
                .map(|c| c[1].trim().to_owned())
        };
        let summary = capture("summary");
        let status = capture("status");
        let task = capture("task");
        if let Some(summary) = summary {
            text = match status {
                Some(s) if !summary.to_lowercase().contains(&s.to_lowercase()) => {
                    format!("{summary} ({s})")
                }
                _ => summary,
            };
        } else if let (Some(task), Some(status)) = (task, status) {
            text = format!("{task} ({status})");
        }
    }
    text = re(r"(?is)\s*<self-review>\s*(.*?)\s*</self-review>\s*")
        .replace_all(&text, |c: &Captures| {
            serde_json::from_str::<serde_json::Value>(&c[1])
                .ok()
                .and_then(|v| v["summary"].as_str().map(|s| s.trim().to_owned()))
                .unwrap_or_default()
        })
        .into_owned();
    for pattern in [
        r"(?i)<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
        r"(?i)<<<END_UNTRUSTED_CHILD_RESULT>>>",
        r"(?i)</?[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+[^>]*>",
        r"(?i)</?(?:command-name|local-command-(?:stdout|stderr|input|result)|task-notification|task-completion-event|runtime-context|begin-untrusted-child-result|end-untrusted-child-result|untrusted-child-result|task-event|command-output|command-result|status|summary|task|source|action)[^>]*>",
    ] {
        text = re(pattern).replace_all(&text, " ").into_owned();
    }
    for (pattern, replacement) in [
        (
            r"(?i)(\bAuthorization\s*:\s*)Bearer\s+[A-Za-z0-9._~+/=-]{8,}",
            "${1}Bearer [redacted]",
        ),
        (
            r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b",
            "Bearer [redacted]",
        ),
        (
            r#"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token)\b(\s*[:=]\s*)([^\s\"'`]+)"#,
            "${1}[redacted]",
        ),
        (
            r"(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token|auth|authorization|key)=)([^&\s]+)",
            "${1}[redacted]",
        ),
        (
            r"\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b",
            "[redacted]",
        ),
    ] {
        text = re(pattern).replace_all(&text, replacement).into_owned();
    }
    text
}

/// Files a bare name can mean; a name with a folder needs no list.
const CODE_FILES: [&str; 21] = [
    "css", "go", "html", "java", "js", "json", "jsx", "lock", "md", "mjs", "py", "rb", "rs", "sh",
    "sql", "swift", "toml", "ts", "tsx", "txt", "yaml",
];
/// What a reply's inline code or link target points at in the workspace: the
/// path and its line, from `src/a.rs:12`, `src/a.rs:12:4` or `src/a.rs#L12`.
/// Reply text can be planted, so only a path that stays inside the workspace
/// qualifies: no root, no home and no `..`. Anything else stays plain text.
pub(crate) fn file_ref(text: &str) -> Option<(&str, Option<usize>)> {
    let (path, line) = match text.rsplit_once("#L") {
        Some((path, line)) => (path, line.parse().ok()),
        None => {
            let mut parts = text.split(':');
            let path = parts.next()?;
            let line = parts.next();
            let column = parts.next();
            if parts.next().is_some()
                || column.is_some_and(|c| c.parse::<usize>().is_err())
                || line.is_some_and(|l| l.parse::<usize>().is_err())
            {
                return None;
            }
            (path, line.and_then(|l| l.parse().ok()))
        }
    };
    let name = path.rsplit('/').next()?;
    let (stem, extension) = name.rsplit_once('.')?;
    let inside = !path.starts_with(['/', '~'])
        && path.split(['/', '\\']).all(|part| !part.is_empty() && part != "..");
    let plain = inside
        && !stem.is_empty()
        && extension.len() >= 2
        && extension.chars().all(|c| c.is_ascii_alphanumeric())
        && extension.starts_with(|c: char| c.is_ascii_alphabetic())
        && !path.starts_with('-')
        && !path.chars().any(|c| c.is_whitespace() || c.is_control());
    (plain && (path.contains('/') || CODE_FILES.contains(&extension))).then_some((path, line))
}
pub fn inline(text: &str) -> Vec<Run> {
    static INLINE: LazyLock<Regex> = LazyLock::new(|| {
        re(
            r"(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`|\[(\d{1,2})\]|https://github\.com/[\w.-]+/[\w.-]+/(?:issues|pull)/(\d+)|\B#(\d{3,})\b)",
        )
    });
    let mut runs = Vec::new();
    let mut cursor = 0;
    for c in INLINE.captures_iter(text) {
        let m = c.get(0).unwrap();
        if m.start() > cursor {
            runs.push(Run {
                style: "text".into(),
                text: text[cursor..m.start()].into(),
            });
        }
        let target = c.get(5).map(|url| url.as_str()).unwrap_or(m.as_str());
        let link = format!("link:{target}");
        let number = c.get(11).map(|n| format!("#{}", n.as_str()));
        let code_link;
        let (style, value) = if c.get(3).is_some() {
            ("image", c.get(2).unwrap().as_str())
        } else if c.get(5).is_some() {
            (link.as_str(), &c[4])
        } else if let Some(number) = &number {
            (link.as_str(), number.as_str())
        } else if c.get(12).is_some() {
            (link.as_str(), m.as_str())
        } else if c.get(6).is_some() {
            // Links and issue numbers keep working inside bold text.
            runs.extend(inline(&c[6]).into_iter().map(|mut run| {
                if run.style == "text" {
                    run.style = "strong".into();
                }
                run
            }));
            cursor = m.end();
            continue;
        } else if c.get(7).is_some() {
            ("em", &c[7])
        } else if c.get(8).is_some() {
            ("strike", &c[8])
        } else if c.get(9).is_some() {
            if file_ref(&c[9]).is_some() {
                code_link = format!("link:file:{}", &c[9]);
                (code_link.as_str(), &c[9])
            } else {
                ("code", &c[9])
            }
        } else {
            ("citation", &c[10])
        };
        runs.push(Run {
            style: style.into(),
            text: value.into(),
        });
        cursor = m.end();
    }
    if cursor < text.len() {
        runs.push(Run {
            style: "text".into(),
            text: text[cursor..].into(),
        });
    }
    runs
}

pub fn markdown(source: &str) -> Vec<Node> {
    let source = sanitize(source);
    let mut nodes = Vec::new();
    let mut fence: Option<(String, usize)> = None;
    let mut code = String::new();
    let lines: Vec<_> = source.split('\n').collect();
    let mut lines = lines.iter().peekable();
    while let Some(&line) = lines.next() {
        let markers = line.bytes().take_while(|&b| b == b'`').count();
        if markers >= 3 && fence.is_none() {
            fence = Some((line[markers..].trim().into(), markers));
            continue;
        }
        if markers >= 3
            && line[markers..].trim().is_empty()
            && fence
                .as_ref()
                .is_some_and(|(_, opening)| markers >= *opening)
        {
            if let Some((language, _)) = fence.take() {
                nodes.push(Node {
                    fence_closed: true,
                    kind: if language.eq_ignore_ascii_case("diff") {
                        "diff-card"
                    } else {
                        "code-block"
                    }
                    .into(),
                    runs: vec![Run {
                        style: "code".into(),
                        text: code.clone(),
                    }],
                    language: Some(if language.eq_ignore_ascii_case("diff") {
                        "diff".into()
                    } else {
                        language
                    }),
                    data: None,
                });
                code.clear();
            }
            continue;
        }
        if fence.is_some() {
            if !code.is_empty() {
                code.push('\n');
            }
            code.push_str(line);
            continue;
        }
        if line.contains('|')
            && lines
                .peek()
                .is_some_and(|next| re(r"^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$").is_match(next))
        {
            let cells = |line: &str| {
                line.split('|')
                    .map(str::trim)
                    .filter(|cell| !cell.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            };
            let headers: Vec<_> = cells(line)
                .iter()
                .map(|cell| {
                    vec![Run {
                        style: "text".into(),
                        text: cell.clone(),
                    }]
                })
                .collect();
            let aligns: Vec<_> = cells(lines.next().unwrap())
                .iter()
                .map(|cell| {
                    if cell.starts_with(':') && cell.ends_with(':') {
                        "center"
                    } else if cell.ends_with(':') {
                        "right"
                    } else {
                        "left"
                    }
                })
                .collect();
            let mut rows = Vec::new();
            while lines.peek().is_some_and(|next| next.contains('|')) {
                rows.push(
                    cells(lines.next().unwrap())
                        .iter()
                        .map(|cell| inline(cell))
                        .collect::<Vec<_>>(),
                );
            }
            nodes.push(Node {
                fence_closed: false,
                kind: "table".into(),
                runs: vec![],
                language: None,
                data: Some(serde_json::json!({"headers":headers,"aligns":aligns,"rows":rows})),
            });
            continue;
        }
        let (kind, body) = if line.trim().is_empty() {
            ("break".into(), "")
        } else if re(r"^(?:-{3,}|\*{3,}|_{3,})$").is_match(line.trim()) {
            ("rule".into(), "")
        } else if let Some(s) = line.strip_prefix("> ") {
            ("quote".into(), s)
        } else if let Some((level, body)) = (1..=4).find_map(|n| {
            line.strip_prefix(&format!("{} ", "#".repeat(n)))
                .map(|s| (n, s))
        }) {
            (format!("h{level}"), body)
        } else if let Some(m) = re(r"^\d+\.\s+").find(line) {
            (format!("ol:{}", line[..m.end()].trim()), &line[m.end()..])
        } else if let Some(m) = re(r"^[-*+]\s+").find(line) {
            ("ul".into(), &line[m.end()..])
        } else {
            ("p".into(), line)
        };
        nodes.push(Node {
            fence_closed: false,
            kind,
            runs: inline(body),
            language: None,
            data: None,
        });
    }
    if let Some((language, _)) = fence {
        if !code.is_empty() {
            nodes.push(Node {
                fence_closed: false,
                kind: if language.eq_ignore_ascii_case("diff") {
                    "diff-card"
                } else {
                    "code-block"
                }
                .into(),
                runs: vec![Run {
                    style: "code".into(),
                    text: code,
                }],
                language: Some(if language.eq_ignore_ascii_case("diff") {
                    "diff".into()
                } else {
                    language
                }),
                data: None,
            });
        }
    }
    nodes
}

#[cfg(test)]
mod link_tests {
    use super::*;
    fn links(text: &str) -> Vec<(String, String)> {
        inline(text)
            .into_iter()
            .filter(|run| run.style.starts_with("link"))
            .map(|run| (run.style, run.text))
            .collect()
    }
    #[test]
    fn issue_links_keep_their_target_and_read_as_numbers() {
        let url = "https://github.com/o8-run/o8/issues/5244";
        assert_eq!(
            links(&format!("see {url}.")),
            [(format!("link:{url}"), "#5244".to_owned())]
        );
        assert_eq!(
            links("fixes #5244 today"),
            [("link:#5244".to_owned(), "#5244".to_owned())]
        );
        assert_eq!(
            links("[the bug](https://example.com/a)"),
            [(
                "link:https://example.com/a".to_owned(),
                "the bug".to_owned()
            )]
        );
    }
    #[test]
    fn links_survive_bold_text() {
        assert_eq!(
            links("**[#5242: search](https://github.com/o8-run/o8/issues/5242)**"),
            [(
                "link:https://github.com/o8-run/o8/issues/5242".to_owned(),
                "#5242: search".to_owned()
            )]
        );
        assert_eq!(links("**#2952 and #5095**").len(), 2);
        let runs = inline("**#2952 and #5095**");
        assert_eq!(runs[1].style, "strong");
    }
    #[test]
    fn short_numbers_and_anchors_stay_plain() {
        assert!(links("step #2 of page#1234").is_empty());
    }
}

#[cfg(test)]
mod file_ref_tests {
    use super::file_ref;

    #[test]
    fn file_references_name_a_path_and_maybe_a_line() {
        assert_eq!(file_ref("src/a.rs"), Some(("src/a.rs", None)));
        assert_eq!(file_ref("src/a.rs:12"), Some(("src/a.rs", Some(12))));
        assert_eq!(file_ref("src/a.rs:12:4"), Some(("src/a.rs", Some(12))));
        assert_eq!(file_ref("src/a.ts#L5"), Some(("src/a.ts", Some(5))));
        assert_eq!(file_ref("package.json"), Some(("package.json", None)));
    }

    #[test]
    fn things_that_only_look_like_files_stay_text() {
        for text in [
            "and/or",
            "e.g",
            "o8.run",
            "1.2.3",
            "foo bar.rs",
            "--flag.rs",
            "a:b:c.rs",
            "self.client",
            "https://a.com/b.ts",
            "note:todo.rs",
            "../x.json",
            "src/../../x.json",
            "/etc/x.txt",
            "~/.ssh/id.txt",
            "..\\x.json",
            "src//a.rs",
        ] {
            assert_eq!(file_ref(text), None, "{text}");
        }
    }
}
