// Git graphs: `gitGraph`.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream paths: src/diagrams/git/parser.ts, db.ts and render.ts at commit
// 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// The commands, the checks that reject a bad merge, checkout or cherry-pick,
// the stable commit ids and the hidden labels of merges without a custom id
// follow it. Top-down graphs fall back to the code block. See NOTICE.md and
// licenses/pele-MIT.txt.
use super::{
    parse::{LIMIT, quoted, text},
    *,
};

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Commit {
    pub(super) id: String,
    pub(super) branch: usize,
    /// The first parent is on this commit's branch, a second is merged in.
    pub(super) parents: Vec<usize>,
    pub(super) tag: String,
    /// Whether the id is drawn under the dot.
    pub(super) shown: bool,
}

const PAD: f32 = 8.;
const DOT: f32 = 7.;
const STEP: f32 = 80.;
const LANE: f32 = 60.;
const TOP: f32 = 36.;
const TEXT: f32 = 12.;

fn width_of(text: &str) -> f32 {
    text.chars().count() as f32 * TEXT * 0.6
}
/// Upstream's id: the sequence number and seven hex digits derived from it,
/// so the same text always gives the same ids.
fn next_id(seq: u32, commits: &[Commit]) -> String {
    let mut salt = seq.wrapping_add(1);
    loop {
        let id = format!("{seq}-{:08x}", salt.wrapping_mul(0x9e37_79b1));
        let id = id[..id.len() - 1].to_owned();
        if !commits.iter().any(|c| c.id == id) {
            return id;
        }
        salt = salt.wrapping_add(0x9e37_79b1);
    }
}
/// `key: "value"` and `key: VALUE` options after a command.
fn options(mut input: &str) -> Result<Vec<(&str, &str)>, ParseError> {
    let mut out = vec![];
    loop {
        input = input.trim_start();
        if input.is_empty() {
            return Ok(out);
        }
        let (key, rest) = input.split_once(':').ok_or(ParseError::Unsupported)?;
        let key = key.trim();
        let (value, rest) = match quoted(rest) {
            Some(pair) => pair,
            None => {
                let rest = rest.trim_start();
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                (&rest[..end], &rest[end..])
            }
        };
        out.push((key, value));
        input = rest;
    }
}
fn branch_name(input: &str) -> Result<String, ParseError> {
    let input = input.trim();
    let name = quoted(input)
        .filter(|(_, rest)| rest.is_empty())
        .map_or(input, |(value, _)| value);
    if name.contains(char::is_whitespace) {
        return Err(ParseError::Unsupported);
    }
    text(name)
}

#[derive(Default)]
struct Builder {
    branches: Vec<String>,
    heads: Vec<Option<usize>>,
    commits: Vec<Commit>,
    current: usize,
    seq: u32,
}
impl Builder {
    fn branch(&self, name: &str) -> Result<usize, ParseError> {
        self.branches
            .iter()
            .position(|b| b == name)
            .ok_or(ParseError::Unsupported)
    }
    fn add(&mut self, mut commit: Commit, custom: Option<&str>) -> Result<(), ParseError> {
        if self.commits.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        commit.id = match custom {
            Some(id) => text(id)?,
            None => next_id(self.seq, &self.commits),
        };
        if self.commits.iter().any(|c| c.id == commit.id) {
            return Err(ParseError::Unsupported);
        }
        self.seq += 1;
        commit.branch = self.current;
        self.commits.push(commit);
        self.heads[self.current] = Some(self.commits.len() - 1);
        Ok(())
    }
}

pub(super) fn parse(header: &str, lines: &[String]) -> Result<Diagram, ParseError> {
    match header.strip_prefix("gitGraph").map(str::trim) {
        Some("" | ":" | "LR:") => {}
        _ => return Err(ParseError::Unsupported),
    }
    let mut b = Builder {
        branches: vec!["main".into()],
        heads: vec![None],
        ..Default::default()
    };
    for line in lines {
        let (command, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
        if command.starts_with("accTitle") || command.starts_with("accDescr") {
            continue;
        }
        match command {
            "commit" => {
                let (mut id, mut tag) = (None, String::new());
                for (key, value) in options(rest)? {
                    match key {
                        "id" => id = Some(value),
                        "tag" => tag = text(value)?,
                        "msg" => {}
                        "type" if matches!(value, "NORMAL" | "REVERSE" | "HIGHLIGHT") => {}
                        _ => return Err(ParseError::Unsupported),
                    }
                }
                let parents = b.heads[b.current].into_iter().collect();
                b.add(
                    Commit {
                        parents,
                        tag,
                        shown: true,
                        ..Default::default()
                    },
                    id,
                )?;
            }
            "branch" => {
                let (name, rest) = rest.split_once(" order:").unwrap_or((rest, ""));
                if !rest.trim().is_empty() && rest.trim().parse::<u32>().is_err() {
                    return Err(ParseError::Unsupported);
                }
                let name = branch_name(name)?;
                if b.branches.contains(&name) {
                    return Err(ParseError::Unsupported);
                }
                if b.branches.len() >= LIMIT {
                    return Err(ParseError::Limit);
                }
                b.branches.push(name);
                b.heads.push(b.heads[b.current]);
                b.current = b.branches.len() - 1;
            }
            "checkout" | "switch" => b.current = b.branch(&branch_name(rest)?)?,
            "merge" => {
                let (name, rest) = rest.trim().split_once(' ').unwrap_or((rest.trim(), ""));
                let other = b.branch(&branch_name(name)?)?;
                let (mut id, mut tag) = (None, String::new());
                for (key, value) in options(rest)? {
                    match key {
                        "id" => id = Some(value),
                        "tag" => tag = text(value)?,
                        "type" if matches!(value, "NORMAL" | "REVERSE" | "HIGHLIGHT") => {}
                        _ => return Err(ParseError::Unsupported),
                    }
                }
                let (Some(head), Some(incoming)) = (b.heads[b.current], b.heads[other]) else {
                    return Err(ParseError::Unsupported);
                };
                if other == b.current || head == incoming {
                    return Err(ParseError::Unsupported);
                }
                b.add(
                    Commit {
                        parents: vec![head, incoming],
                        tag,
                        shown: id.is_some(),
                        ..Default::default()
                    },
                    id,
                )?;
            }
            "cherry-pick" => {
                let (mut source, mut tag) = (None, None);
                for (key, value) in options(rest)? {
                    match key {
                        "id" => source = Some(value),
                        "tag" => tag = Some(text(value)?),
                        _ => return Err(ParseError::Unsupported),
                    }
                }
                let source = source
                    .and_then(|id| b.commits.iter().position(|c| c.id == id))
                    .ok_or(ParseError::Unsupported)?;
                let head = b.heads[b.current].ok_or(ParseError::Unsupported)?;
                // A merge needs a parent named, which is not drawn here.
                if b.commits[source].branch == b.current || b.commits[source].parents.len() > 1 {
                    return Err(ParseError::Unsupported);
                }
                let tag = tag.unwrap_or_else(|| format!("cherry-pick:{}", b.commits[source].id));
                b.add(
                    Commit {
                        parents: vec![head, source],
                        tag,
                        shown: true,
                        ..Default::default()
                    },
                    None,
                )?;
            }
            _ => return Err(ParseError::Unsupported),
        }
    }
    Ok(Diagram::Git {
        branches: b.branches,
        commits: b.commits,
    })
}

/// Branches as lanes left to right, commits as dots in order along them.
pub(super) fn layout(branches: &[String], commits: &[Commit]) -> Scene {
    let mut scene = Scene::default();
    let names = branches.iter().map(|b| width_of(b)).fold(0f32, f32::max) + 24.;
    let left = PAD + names;
    let x = |index: usize| left + STEP / 2. + index as f32 * STEP;
    let y = |branch: usize| PAD + TOP + branch as f32 * LANE;
    for (index, name) in branches.iter().enumerate() {
        scene.labels.push(Label {
            text: name.clone(),
            rect: BoxRect {
                x: PAD,
                y: y(index) - TEXT * 0.75,
                w: names - 8.,
                h: TEXT * 1.5,
            },
            left: true,
            ..Default::default()
        });
    }
    for (index, commit) in commits.iter().enumerate() {
        let (cx, cy) = (x(index), y(commit.branch));
        for (order, &parent) in commit.parents.iter().enumerate() {
            let from = &commits[parent];
            let (px, py) = (x(parent), y(from.branch));
            // A branch leaves just after its base, and a merge joins just before its commit.
            let (bend, color) = if order == 0 {
                (px + STEP / 2., commit.branch)
            } else {
                (cx - STEP / 2., from.branch)
            };
            let points = if py == cy {
                vec![(px, py), (cx, cy)]
            } else {
                vec![(px, py), (bend, py), (bend, cy), (cx, cy)]
            };
            scene.strokes.push(Stroke {
                points,
                dashed: false,
                arrow: false,
                marks: [Marker::None; 2],
                gap: None,
                color: Some(color),
            });
        }
        scene.wedges.push(Wedge {
            cx,
            cy,
            r: DOT,
            start: 0.,
            end: std::f32::consts::TAU,
            color: commit.branch,
        });
        if commit.shown {
            scene.labels.push(Label {
                text: commit.id.clone(),
                rect: BoxRect {
                    x: cx - STEP / 2. + 2.,
                    y: cy + DOT + 4.,
                    w: STEP - 4.,
                    h: TEXT * 1.5,
                },
                ..Default::default()
            });
        }
        if !commit.tag.is_empty() {
            let w = (width_of(&commit.tag) + 8.).min(STEP - 4.);
            scene.labels.push(Label {
                text: commit.tag.clone(),
                rect: BoxRect {
                    x: cx - w / 2.,
                    y: cy - DOT - 6. - TEXT * 1.5,
                    w,
                    h: TEXT * 1.5,
                },
                background: true,
                ..Default::default()
            });
        }
    }
    scene.width = left + commits.len().max(1) as f32 * STEP + PAD;
    scene.height = y(branches.len() - 1) + DOT + 4. + TEXT * 1.5 + PAD;
    scene
}
