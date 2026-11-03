// Class diagrams: `classDiagram` and `classDiagram-v2`.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream paths: src/diagrams/class/parser.ts, lexer.ts, db.ts, members.ts and
// render.ts at commit 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// Class statements, member blocks, annotations, relation ends, cardinalities,
// notes and the member display rules follow it. Namespaces fall back to the
// code block. See NOTICE.md and licenses/pele-MIT.txt.
use super::{
    parse::{LIMIT, quoted, text},
    *,
};

#[derive(Default)]
struct Builder {
    nodes: Vec<Vertex>,
    edges: Vec<Edge>,
    notes: usize,
}
impl Builder {
    fn class(&mut self, id: &str, label: &str) -> Result<usize, ParseError> {
        if let Some(index) = self.nodes.iter().position(|n| n.id == id) {
            if label != id {
                self.nodes[index].label = label.into();
            }
            return Ok(index);
        }
        if self.nodes.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        self.nodes.push(Vertex {
            id: id.into(),
            label: label.into(),
            shape: Shape::Class,
            sections: vec![vec![], vec![]],
            ..Default::default()
        });
        Ok(self.nodes.len() - 1)
    }
    fn member(&mut self, index: usize, input: &str) -> Result<(), ParseError> {
        let input = input.trim();
        if input.is_empty() {
            return Ok(());
        }
        if let Some(annotation) = input
            .strip_prefix("<<")
            .and_then(|rest| rest.strip_suffix(">>"))
        {
            self.nodes[index]
                .above
                .push(format!("«{}»", text(annotation)?));
            return Ok(());
        }
        let (method, display) = member(input);
        let section = &mut self.nodes[index].sections[usize::from(method)];
        if section.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        section.push(text(&display)?);
        Ok(())
    }
    fn edge(&mut self, edge: Edge) -> Result<(), ParseError> {
        if self.edges.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        self.edges.push(edge);
        Ok(())
    }
}
/// `~T~` generics shown as `<T>`: a tilde before a word opens one, any other closes one.
fn generics(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '~' {
            out.push(if chars.peek().is_some_and(|c| c.is_alphanumeric()) {
                '<'
            } else {
                '>'
            });
        } else {
            out.push(c);
        }
    }
    out
}
/// A member as displayed, and whether it is a method: visibility, name,
/// parameters and a return type after a colon. A trailing `$` or `*` marks a
/// static or abstract member and is not shown.
fn member(input: &str) -> (bool, String) {
    let visible = |c: char| matches!(c, '#' | '+' | '~' | '-');
    if let Some(close) = input.rfind(')')
        && let Some(open) = input[..close].rfind('(')
        && open > 0
    {
        let first = input.chars().next().unwrap_or(' ');
        let visibility = visible(first) && open > 1;
        let name = &input[usize::from(visibility)..open];
        let parameters = input[open + 1..close].trim();
        let mut rest = &input[close + 1..];
        let mut classifier = false;
        if let Some(next) = rest.chars().next()
            && (next == '$' || next == '*' || next.is_whitespace())
        {
            classifier = !next.is_whitespace();
            rest = &rest[next.len_utf8()..];
        }
        let mut returns = rest.trim();
        if !classifier {
            returns = returns.trim_end_matches(['$', '*']);
        }
        let mut display = format!(
            "{}{}({})",
            if visibility { &input[..1] } else { "" },
            generics(name.trim()),
            generics(parameters)
        );
        if !returns.is_empty() {
            display += &format!(" : {}", generics(returns));
        }
        return (true, display);
    }
    let visibility = input.starts_with(visible);
    let body = &input[usize::from(visibility)..];
    let body = body.strip_suffix(['$', '*']).unwrap_or(body);
    let display = format!(
        "{}{}",
        if visibility { &input[..1] } else { "" },
        generics(body.trim())
    );
    (false, display.trim().to_owned())
}
/// A class name with its generics, the label to show, and the rest.
fn name(input: &str) -> Result<(&str, String, &str), ParseError> {
    let input = input.trim_start();
    let end = input
        .find(|c: char| !c.is_alphanumeric() && c != '_')
        .unwrap_or(input.len());
    if end > 512 {
        return Err(ParseError::Limit);
    }
    if end == 0 {
        return Err(ParseError::Unsupported);
    }
    let id = &input[..end];
    let mut rest = &input[end..];
    let mut label = id.to_owned();
    if rest.starts_with('~') {
        let close = rest
            .find(char::is_whitespace)
            .unwrap_or(rest.len())
            .min(rest.find(':').unwrap_or(rest.len()));
        let generic = &rest[..close];
        if generic.len() < 2 || !generic.ends_with('~') {
            return Err(ParseError::Unsupported);
        }
        label = generics(&format!("{id}{generic}"));
        rest = &rest[close..];
    }
    if let Some(tail) = rest.strip_prefix(":::") {
        rest = tail.trim_start_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '-');
    }
    Ok((id, label, rest.trim_start()))
}
const LEFT: [(&str, Marker); 5] = [
    ("<|", Marker::Triangle),
    ("()", Marker::Circle),
    ("*", Marker::FilledDiamond),
    ("o", Marker::Diamond),
    ("<", Marker::Arrow),
];
const RIGHT: [(&str, Marker); 5] = [
    ("|>", Marker::Triangle),
    ("()", Marker::Circle),
    ("*", Marker::FilledDiamond),
    ("o", Marker::Diamond),
    (">", Marker::Arrow),
];
/// `[left mark](--|..)[right mark]`, as a pair of markers, whether the line is
/// dotted, and the rest.
fn relation(input: &str) -> Result<([Marker; 2], bool, &str), ParseError> {
    fn line(rest: &str) -> Option<(bool, &str)> {
        ["--", ".."]
            .iter()
            .find(|line| rest.starts_with(**line))
            .map(|line| (*line == "..", &rest[2..]))
    }
    let (left, (dotted, rest)) = LEFT
        .iter()
        .find_map(|&(token, mark)| Some((mark, line(input.strip_prefix(token)?)?)))
        .or_else(|| Some((Marker::None, line(input)?)))
        .ok_or(ParseError::Unsupported)?;
    let (right, rest) = RIGHT
        .iter()
        .find_map(|&(token, mark)| {
            let rest = rest.strip_prefix(token)?;
            // `--o` ends in a diamond, `--oven` names a class.
            (token != "o" || !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
                .then_some((mark, rest))
        })
        .unwrap_or((Marker::None, rest));
    Ok(([left, right], dotted, rest.trim_start()))
}

pub(super) fn parse(lines: &[String]) -> Result<Diagram, ParseError> {
    let mut b = Builder::default();
    let mut lr = false;
    let mut lines = lines.iter().map(String::as_str);
    while let Some(line) = lines.next() {
        if let Some(direction) = line.strip_prefix("direction ") {
            lr = match direction.trim() {
                "LR" | "RL" => true,
                "TB" | "BT" | "TD" => false,
                _ => return Err(ParseError::Unsupported),
            };
            continue;
        }
        // Styling, links and accessibility text change nothing that is drawn here.
        if [
            "classDef ",
            "style ",
            "cssClass ",
            "click ",
            "link ",
            "callback ",
            "accTitle",
            "accDescr",
            "title ",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
        {
            continue;
        }
        if let Some(tail) = line.strip_prefix("note ") {
            let (target, tail) = match tail.strip_prefix("for ") {
                Some(tail) => {
                    let (id, label, rest) = name(tail)?;
                    (Some(b.class(id, &label)?), rest)
                }
                None => (None, tail),
            };
            let (label, rest) = quoted(tail).ok_or(ParseError::Unsupported)?;
            if !rest.is_empty() {
                return Err(ParseError::Unsupported);
            }
            let id = format!("note{}", b.notes);
            b.notes += 1;
            let note = b.class(&id, &id)?;
            b.nodes[note].shape = Shape::Note;
            b.nodes[note].sections.clear();
            b.nodes[note].label = text(&label.replace("\\n", " "))?;
            if let Some(to) = target {
                b.edge(Edge {
                    from: note,
                    to,
                    dashed: true,
                    ..Default::default()
                })?;
            }
            continue;
        }
        if let Some(tail) = line.strip_prefix("<<") {
            let (annotation, rest) = tail.split_once(">>").ok_or(ParseError::Unsupported)?;
            let (id, label, rest) = name(rest)?;
            if !rest.is_empty() {
                return Err(ParseError::Unsupported);
            }
            let index = b.class(id, &label)?;
            b.member(index, &format!("<<{annotation}>>"))?;
            continue;
        }
        if let Some(tail) = line.strip_prefix("class ") {
            let (id, mut label, mut rest) = name(tail)?;
            if let Some(tail) = rest.strip_prefix('[') {
                let (value, tail) = quoted(tail).ok_or(ParseError::Unsupported)?;
                label = text(value)?;
                rest = tail
                    .strip_prefix(']')
                    .ok_or(ParseError::Unsupported)?
                    .trim_start();
            }
            let index = b.class(id, &label)?;
            match rest {
                "" | "{}" | "{ }" => {}
                "{" => loop {
                    match lines.next() {
                        Some("}") => break,
                        Some(line) => b.member(index, line)?,
                        None => return Err(ParseError::Unsupported),
                    }
                },
                _ => return Err(ParseError::Unsupported),
            }
            continue;
        }
        let (first, first_label, rest) = name(line)?;
        if let Some(member) = rest.strip_prefix(':') {
            let index = b.class(first, &first_label)?;
            b.member(index, member)?;
            continue;
        }
        let (tail_card, rest) = quoted(rest).unwrap_or(("", rest));
        let (marks, dashed, rest) = relation(rest)?;
        let (head_card, rest) = quoted(rest).unwrap_or(("", rest));
        let (second, second_label, rest) = name(rest)?;
        let label = match rest.strip_prefix(':') {
            Some(label) if !label.trim().is_empty() => text(label)?,
            Some(_) => String::new(),
            None if rest.is_empty() => String::new(),
            None => return Err(ParseError::Unsupported),
        };
        let from = b.class(first, &first_label)?;
        let to = b.class(second, &second_label)?;
        let end = |card: &str| {
            if card.trim().is_empty() {
                Ok(String::new())
            } else {
                text(card)
            }
        };
        let ends = [end(tail_card)?, end(head_card)?];
        b.edge(Edge {
            from,
            to,
            label,
            dashed,
            marks,
            ends,
            ..Default::default()
        })?;
    }
    if b.nodes.is_empty() {
        return Err(ParseError::Unsupported);
    }
    Ok(Diagram::Flow {
        lr,
        nodes: b.nodes,
        edges: b.edges,
    })
}
