// State diagrams: `stateDiagram` and `stateDiagram-v2`.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream paths: src/diagrams/state/parser.ts, db.ts, graph.ts and render.ts
// at commit 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// The statements, the scoping of `[*]`, the description rules and the sizes of
// the pseudo-states follow it. Composite states and concurrent regions are not
// ported and fall back to the code block. See NOTICE.md and licenses/pele-MIT.txt.
use super::{
    parse::{LIMIT, quoted, text},
    *,
};

/// Pseudo-state sizes, as drawn upstream.
pub(super) const START: f32 = 14.;
pub(super) const END: f32 = 18.;
pub(super) const CHOICE: f32 = 30.;
pub(super) const BAR: f32 = 8.;

#[derive(Default)]
struct Builder {
    nodes: Vec<Vertex>,
    descriptions: Vec<Vec<String>>,
    edges: Vec<Edge>,
    notes: usize,
}
impl Builder {
    fn state(&mut self, id: &str, shape: Shape) -> Result<usize, ParseError> {
        if let Some(index) = self.nodes.iter().position(|n| n.id == id) {
            return Ok(index);
        }
        if self.nodes.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        let pseudo = shape != Shape::Round;
        self.nodes.push(Vertex {
            id: id.into(),
            label: if pseudo { String::new() } else { id.into() },
            shape,
            ..Default::default()
        });
        self.descriptions.push(vec![]);
        Ok(self.nodes.len() - 1)
    }
    /// An endpoint of a transition. `[*]` is the root's start on the left and
    /// its end on the right.
    fn endpoint(&mut self, id: &str, left: bool) -> Result<usize, ParseError> {
        match (id, left) {
            ("[*]", true) => self.state("root_start", Shape::Start),
            ("[*]", false) => self.state("root_end", Shape::End),
            _ => self.state(id, Shape::Round),
        }
    }
    fn edge(&mut self, edge: Edge) -> Result<(), ParseError> {
        if self.edges.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        self.edges.push(edge);
        Ok(())
    }
    fn note(&mut self, id: &str, left: bool, label: &str) -> Result<(), ParseError> {
        let owner = self.state(id, Shape::Round)?;
        let note = self.state(&format!("{id}----note-{}", self.notes), Shape::Note)?;
        self.notes += 1;
        self.nodes[note].label = text(label)?;
        let (from, to) = if left { (note, owner) } else { (owner, note) };
        self.edge(Edge {
            from,
            to,
            dashed: true,
            ..Default::default()
        })
    }
}
/// A state id, `[*]`, or a quoted name, and the rest of the line. A
/// `:::class` suffix only styles the state and is dropped.
fn id(input: &str) -> Result<(&str, &str), ParseError> {
    let input = input.trim_start();
    if let Some(rest) = input.strip_prefix("[*]") {
        return Ok(("[*]", rest.trim_start()));
    }
    let end = input
        .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '.')
        .unwrap_or(input.len());
    if end > 512 {
        return Err(ParseError::Limit);
    }
    if end == 0 {
        return Err(ParseError::Unsupported);
    }
    let mut rest = &input[end..];
    if let Some(tail) = rest.strip_prefix(":::") {
        rest = tail.trim_start_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '-');
    }
    Ok((&input[..end], rest.trim_start()))
}
fn described(text: &str) -> &str {
    text.strip_prefix(':').unwrap_or(text).trim()
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
            "hide empty description",
            "scale ",
            "accTitle",
            "accDescr",
            "title ",
            "classDef ",
            "class ",
            "style ",
            "click ",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
        {
            continue;
        }
        if let Some(tail) = line.strip_prefix("note ") {
            if tail.starts_with('"') {
                // A floating note has no effect on the drawing upstream either.
                continue;
            }
            let (left, tail) = if let Some(tail) = tail.strip_prefix("left of ") {
                (true, tail)
            } else if let Some(tail) = tail.strip_prefix("right of ") {
                (false, tail)
            } else {
                return Err(ParseError::Unsupported);
            };
            let (owner, rest) = id(tail)?;
            if owner == "[*]" {
                return Err(ParseError::Unsupported);
            }
            if let Some(label) = rest.strip_prefix(':') {
                b.note(owner, left, label)?;
            } else if rest.is_empty() {
                let mut body = vec![];
                loop {
                    match lines.next() {
                        Some("end note") => break,
                        Some(line) => body.push(line),
                        None => return Err(ParseError::Unsupported),
                    }
                }
                b.note(owner, left, &body.join(" "))?;
            } else {
                return Err(ParseError::Unsupported);
            }
            continue;
        }
        if let Some(tail) = line.strip_prefix("state ") {
            if line.ends_with('{') {
                return Err(ParseError::Unsupported);
            }
            if let Some((description, rest)) = quoted(tail) {
                let rest = rest.strip_prefix("as ").ok_or(ParseError::Unsupported)?;
                let (name, rest) = id(rest)?;
                if name == "[*]" || !rest.is_empty() {
                    return Err(ParseError::Unsupported);
                }
                let index = b.state(name, Shape::Round)?;
                b.descriptions[index].push(text(description)?);
                continue;
            }
            let (name, rest) = id(tail)?;
            let shape = match rest {
                "" => Shape::Round,
                "<<choice>>" => Shape::Choice,
                "<<fork>>" | "<<join>>" => Shape::Bar,
                _ => return Err(ParseError::Unsupported),
            };
            if name == "[*]" {
                return Err(ParseError::Unsupported);
            }
            let index = b.state(name, shape)?;
            if shape != Shape::Round && b.nodes[index].shape == Shape::Round {
                b.nodes[index].shape = shape;
                b.nodes[index].label.clear();
            }
            continue;
        }
        let (first, rest) = id(line)?;
        if let Some(tail) = rest.strip_prefix("-->") {
            let (second, rest) = id(tail)?;
            let label = if rest.is_empty() {
                String::new()
            } else {
                let label = rest.strip_prefix(':').ok_or(ParseError::Unsupported)?;
                if label.trim().is_empty() {
                    String::new()
                } else {
                    text(label)?
                }
            };
            let from = b.endpoint(first, true)?;
            let to = b.endpoint(second, false)?;
            b.edge(Edge {
                from,
                to,
                label,
                arrow: true,
                ..Default::default()
            })?;
        } else if first == "[*]" {
            return Err(ParseError::Unsupported);
        } else if rest.starts_with(':') {
            let index = b.state(first, Shape::Round)?;
            b.descriptions[index].push(text(described(rest))?);
        } else if rest.is_empty() {
            b.state(first, Shape::Round)?;
        } else {
            return Err(ParseError::Unsupported);
        }
    }
    if b.nodes.is_empty() {
        return Err(ParseError::Unsupported);
    }
    // The first description names a state; the rest go under a rule.
    for (node, descriptions) in b.nodes.iter_mut().zip(b.descriptions) {
        let mut descriptions = descriptions.into_iter();
        if node.shape != Shape::Round {
            continue;
        }
        if let Some(first) = descriptions.next() {
            node.label = first;
        }
        let rest: Vec<_> = descriptions.collect();
        if !rest.is_empty() {
            node.sections = vec![rest];
        }
    }
    Ok(Diagram::Flow {
        lr,
        nodes: b.nodes,
        edges: b.edges,
    })
}
