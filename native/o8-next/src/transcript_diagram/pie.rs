// Pie charts: `pie`.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream paths: src/diagrams/pie/parser.ts, model.ts and render.ts at commit
// 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// The grammar, the first-value-wins sections, the hidden slices under one
// percent, the outside labels for narrow slices and the legend placement
// follow it. See NOTICE.md and licenses/pele-MIT.txt.
use super::{
    parse::{LIMIT, quoted, text},
    *,
};

const RADIUS: f32 = 120.;
const SWATCH: f32 = 12.;
const ROW: f32 = 26.;
const GAP: f32 = 32.;
const OUTSIDE: f32 = 28.;
const PAD: f32 = 8.;
const TEXT: f32 = 12.;
/// Upstream places percentages three quarters of the way out.
const TEXT_POSITION: f32 = 0.75;

fn width_of(text: &str) -> f32 {
    text.chars().count() as f32 * TEXT * 0.6
}
/// `pie [showData] [title …]`, then `"label" : value` sections and `title` lines.
pub(super) fn parse(header: &str, lines: &[String]) -> Result<Diagram, ParseError> {
    let mut title = String::new();
    let rest = header.strip_prefix("pie").ok_or(ParseError::Unsupported)?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return Err(ParseError::Unsupported);
    }
    let rest = rest.trim_start();
    let (show_data, rest) = match rest.strip_prefix("showData") {
        Some(tail) if tail.is_empty() || tail.starts_with(char::is_whitespace) => {
            (true, tail.trim_start())
        }
        _ => (false, rest),
    };
    fn heading(line: &str) -> Option<&str> {
        line.strip_prefix("title")
            .filter(|tail| tail.is_empty() || tail.starts_with(char::is_whitespace))
            .map(str::trim)
    }
    if !rest.is_empty() {
        title = heading(rest).ok_or(ParseError::Unsupported)?.to_owned();
    }
    let mut slices: Vec<(String, f64)> = vec![];
    for line in lines {
        if let Some(value) = heading(line) {
            title = value.to_owned();
            continue;
        }
        if line.starts_with("accTitle") || line.starts_with("accDescr") {
            continue;
        }
        let (label, rest) = quoted(line).ok_or(ParseError::Unsupported)?;
        let value = rest
            .strip_prefix(':')
            .ok_or(ParseError::Unsupported)?
            .trim();
        // Upstream's number: an optional minus, digits, and an optional fraction.
        let digits = value.strip_prefix('-').unwrap_or(value);
        let (whole, fraction) = digits.split_once('.').unwrap_or((digits, "0"));
        if whole.is_empty()
            || fraction.is_empty()
            || !whole
                .chars()
                .chain(fraction.chars())
                .all(|c| c.is_ascii_digit())
        {
            return Err(ParseError::Unsupported);
        }
        let value: f64 = value.parse().map_err(|_| ParseError::Unsupported)?;
        if value < 0. || !value.is_finite() {
            return Err(ParseError::Unsupported);
        }
        let label = text(label)?;
        if slices.iter().any(|(existing, _)| *existing == label) {
            continue;
        }
        if slices.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        slices.push((label, value));
    }
    if title.len() > 512 {
        return Err(ParseError::Limit);
    }
    if title.chars().any(char::is_control) {
        return Err(ParseError::Unsupported);
    }
    Ok(Diagram::Pie {
        title,
        show_data,
        slices,
    })
}

pub(super) fn layout(title: &str, show_data: bool, slices: &[(String, f64)], room: f32) -> Scene {
    let mut scene = Scene::default();
    let sum: f64 = slices.iter().map(|(_, value)| value).sum();
    let legend: Vec<String> = slices
        .iter()
        .map(|(label, value)| {
            if show_data {
                format!("{label} [{value}]")
            } else {
                label.clone()
            }
        })
        .collect();
    let legend_width = legend.iter().map(|l| width_of(l)).fold(0f32, f32::max)
        + if legend.is_empty() { 0. } else { SWATCH + 8. };
    let legend_height = legend.len() as f32 * ROW;
    let title_height = if title.is_empty() {
        0.
    } else {
        TEXT * 1.5 + 16.
    };
    // A slice too thin for its percentage is labelled outside the rim.
    let shares: Vec<f32> = slices
        .iter()
        .map(|(_, value)| {
            let share = if sum > 0. { (value / sum) as f32 } else { 0. };
            if share * 100. >= 1. && format!("{:.0}", share * 100.) != "0" {
                share
            } else {
                0.
            }
        })
        .collect();
    let narrow: Vec<bool> = shares
        .iter()
        .map(|&share| {
            if share == 0. || share >= 0.5 {
                return false;
            }
            let chord = 2. * RADIUS * TEXT_POSITION * (share * std::f32::consts::PI).sin();
            chord < width_of(&format!("{:.0}%", share * 100.)) + 6.
        })
        .collect();
    let margin = if narrow.contains(&true) { OUTSIDE } else { 0. };
    let diameter = (RADIUS + margin) * 2.;
    // The legend goes under the pie when it does not fit beside it.
    let beside = legend_width == 0. || diameter + GAP + legend_width + 2. * PAD <= room;
    let (mut width, mut height) = (diameter, diameter);
    if beside {
        width += if legend_width > 0. {
            GAP + legend_width
        } else {
            0.
        };
        height = height.max(legend_height);
    } else {
        width = width.max(legend_width);
        height += 20. + legend_height;
    }
    width = width.max(width_of(title));
    let cx = PAD + if beside { diameter / 2. } else { width / 2. };
    let top = PAD + title_height;
    let cy = top + if beside { height / 2. } else { diameter / 2. };
    if !title.is_empty() {
        scene.labels.push(Label {
            text: title.into(),
            rect: BoxRect {
                x: PAD,
                y: PAD,
                w: width,
                h: TEXT * 1.5,
            },
            background: false,
            left: false,
            ..Default::default()
        });
    }
    let mut angle = 0f32;
    let rim = RADIUS + OUTSIDE / 2.;
    let mut outside: Vec<(f32, f32, f32)> = vec![];
    for (index, &share) in shares.iter().enumerate() {
        if share == 0. {
            continue;
        }
        let end = angle + share * std::f32::consts::TAU;
        scene.wedges.push(Wedge {
            cx,
            cy,
            r: RADIUS,
            start: angle,
            end,
            color: index,
        });
        let text = format!("{:.0}%", share * 100.);
        let w = width_of(&text) + 4.;
        let mid = (angle + end) / 2.;
        let (x, y, on_fill) = if narrow[index] {
            let clear = |x: f32, y: f32, placed: &[(f32, f32, f32)]| {
                placed.iter().all(|&(ox, oy, ow)| {
                    (x - ox).abs() >= (w + ow) / 2. + 2. || (y - oy).abs() >= TEXT + 2.
                })
            };
            let mut at = mid;
            for _ in 0..360 {
                if clear(at.sin() * rim, -at.cos() * rim, &outside) {
                    break;
                }
                at += 2. / rim;
            }
            let (x, y) = (at.sin() * rim, -at.cos() * rim);
            outside.push((x, y, w));
            (x, y, None)
        } else {
            let r = RADIUS * TEXT_POSITION;
            (mid.sin() * r, -mid.cos() * r, Some(index))
        };
        scene.labels.push(Label {
            text,
            rect: BoxRect {
                x: cx + x - w / 2.,
                y: cy + y - TEXT * 0.75,
                w,
                h: TEXT * 1.5,
            },
            background: false,
            left: false,
            on_fill,
            ..Default::default()
        });
        angle = end;
    }
    let (lx, ly) = if beside {
        (
            cx + diameter / 2. + GAP,
            top + (height - legend_height) / 2.,
        )
    } else {
        (PAD + (width - legend_width) / 2., top + diameter + 20.)
    };
    for (index, label) in legend.into_iter().enumerate() {
        let y = ly + index as f32 * ROW + ROW / 2.;
        scene.swatches.push((
            BoxRect {
                x: lx,
                y: y - SWATCH / 2.,
                w: SWATCH,
                h: SWATCH,
            },
            index,
        ));
        let w = width_of(&label) + 4.;
        scene.labels.push(Label {
            text: label,
            rect: BoxRect {
                x: lx + SWATCH + 8.,
                y: y - TEXT * 0.75,
                w,
                h: TEXT * 1.5,
            },
            background: false,
            left: true,
            ..Default::default()
        });
    }
    scene.width = width + 2. * PAD;
    scene.height = height + title_height + 2. * PAD;
    scene
}
