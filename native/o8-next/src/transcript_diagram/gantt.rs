// Gantt charts: `gantt`.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream paths: src/diagrams/gantt/parser.ts, db.ts, dates.ts and axis.ts at
// commit 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// Task fields (tags, then an optional id, start and end or duration), `after`
// and `until` references, a task without a start following the one before,
// and exclusive end dates follow it. Other date formats, excluded days,
// vertical markers and a first task without a start date fall back to the
// code block. See NOTICE.md and licenses/pele-MIT.txt.
use super::{
    parse::{LIMIT, text},
    *,
};

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Task {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) section: usize,
    /// Days since 1970-01-01; the end is exclusive.
    pub(super) start: f64,
    pub(super) end: f64,
    pub(super) milestone: bool,
    pub(super) crit: bool,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Chart {
    pub(super) title: String,
    pub(super) sections: Vec<String>,
    pub(super) tasks: Vec<Task>,
}

const PAD: f32 = 8.;
const ROW: f32 = 28.;
const BAR: f32 = 20.;
const TEXT: f32 = 12.;
/// The narrowest gap between two axis dates.
const TICK: f32 = 96.;

fn width_of(text: &str) -> f32 {
    text.chars().count() as f32 * TEXT * 0.6
}
/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
/// The date `days` after 1970-01-01, as `YYYY-MM-DD`.
fn date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}
/// A strict `YYYY-MM-DD`.
fn parse_date(input: &str) -> Option<f64> {
    let mut parts = input.split('-');
    let (year, month, day) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some()
        || year.len() != 4
        || month.len() != 2
        || day.len() != 2
        || !input.chars().all(|c| c.is_ascii_digit() || c == '-')
    {
        return None;
    }
    let (year, month, day): (i64, i64, i64) =
        (year.parse().ok()?, month.parse().ok()?, day.parse().ok()?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let length = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => return None,
    };
    (1..=length)
        .contains(&day)
        .then(|| days(year, month, day) as f64)
}
/// A duration such as `3d`, `1.5w` or `12h`, in days.
fn duration(input: &str) -> Option<f64> {
    let unit = input.chars().last()?;
    let value: f64 = input[..input.len() - unit.len_utf8()].parse().ok()?;
    let scale = match unit {
        'd' => 1.,
        'w' => 7.,
        'h' => 1. / 24.,
        _ => return None,
    };
    (value.is_finite() && (0. ..=36_500.).contains(&value)).then_some(value * scale)
}

/// The latest end of the tasks `after` names, all of which come earlier.
fn after(ids: &str, tasks: &[Task]) -> Option<f64> {
    let mut latest: Option<f64> = None;
    for id in ids.split_whitespace() {
        let end = tasks.iter().find(|t| t.id == id)?.end;
        latest = Some(latest.map_or(end, |l| l.max(end)));
    }
    latest
}

pub(super) fn parse(lines: &[String]) -> Result<Diagram, ParseError> {
    let mut chart = Chart::default();
    let mut section = None;
    for line in lines {
        let (keyword, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
        let rest = rest.trim();
        match keyword {
            "title" => {
                chart.title = text(rest)?;
                continue;
            }
            "dateFormat" if rest == "YYYY-MM-DD" => continue,
            "dateFormat" => return Err(ParseError::Unsupported),
            // Display choices this chart draws its own way.
            "axisFormat" | "tickInterval" | "todayMarker" | "weekday" | "displayMode"
            | "includes" | "click" => continue,
            "section" => {
                if chart.sections.len() >= LIMIT {
                    return Err(ParseError::Limit);
                }
                chart.sections.push(text(rest)?);
                section = Some(chart.sections.len() - 1);
                continue;
            }
            _ if keyword.starts_with("accTitle") || keyword.starts_with("accDescr") => continue,
            _ => {}
        }
        let (name, data) = line.split_once(':').ok_or(ParseError::Unsupported)?;
        let mut fields: Vec<&str> = data.split(',').map(str::trim).collect();
        let mut task = Task {
            name: text(name)?,
            ..Default::default()
        };
        while let Some(&tag) = fields.first() {
            match tag {
                "active" | "done" => {}
                "crit" => task.crit = true,
                "milestone" => task.milestone = true,
                _ => break,
            }
            fields.remove(0);
        }
        let start = match fields.len() {
            1 => chart.tasks.last().map(|t| t.end),
            2 | 3 => {
                let start = fields[fields.len() - 2];
                match start.strip_prefix("after ") {
                    Some(ids) => after(ids, &chart.tasks),
                    None => parse_date(start),
                }
            }
            _ => None,
        };
        task.start = start.ok_or(ParseError::Unsupported)?;
        let end = fields[fields.len() - 1];
        task.end = if let Some(id) = end.strip_prefix("until ") {
            chart
                .tasks
                .iter()
                .find(|t| t.id == id.trim())
                .map(|t| t.start)
        } else {
            parse_date(end).or_else(|| duration(end).map(|d| task.start + d))
        }
        .filter(|&end| end >= task.start)
        .ok_or(ParseError::Unsupported)?;
        if fields.len() == 3 {
            task.id = fields[0].into();
        }
        if chart.tasks.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        if section.is_none() {
            chart.sections.push(String::new());
            section = Some(0);
        }
        task.section = section.unwrap_or(0);
        chart.tasks.push(task);
    }
    if chart.tasks.is_empty() {
        return Err(ParseError::Unsupported);
    }
    Ok(Diagram::Gantt(chart))
}

/// Sections down the left, a bar per task against a date axis.
pub(super) fn layout(chart: &Chart, room: f32) -> Scene {
    let mut scene = Scene::default();
    let first = chart
        .tasks
        .iter()
        .map(|t| t.start)
        .fold(f64::INFINITY, f64::min);
    let last = chart
        .tasks
        .iter()
        .map(|t| t.end)
        .fold(f64::NEG_INFINITY, f64::max);
    let span = (last - first).max(1.);
    let names = chart
        .sections
        .iter()
        .map(|s| width_of(s))
        .fold(0f32, f32::max)
        .clamp(48., 160.)
        + 16.;
    let left = PAD + names;
    let chart_width = (room - left - PAD).clamp(240., 1200.);
    let x = |day: f64| left + ((day - first) / span) as f32 * chart_width;
    let mut top = PAD;
    if !chart.title.is_empty() {
        scene.labels.push(Label {
            text: chart.title.clone(),
            rect: BoxRect {
                x: PAD,
                y: top,
                w: left + chart_width - PAD,
                h: TEXT * 1.5,
            },
            ..Default::default()
        });
        top += TEXT * 1.5 + 12.;
    }
    let rows = chart.tasks.len() as f32;
    let mut section_start = 0;
    for (index, task) in chart.tasks.iter().enumerate() {
        let y = top + index as f32 * ROW + (ROW - BAR) / 2.;
        let next = chart.tasks.get(index + 1).map(|t| t.section);
        if next != Some(task.section) {
            // The section's name, centered on its rows, and a rule under them.
            let name = &chart.sections[task.section];
            let section_top = top + section_start as f32 * ROW;
            let section_bottom = top + (index + 1) as f32 * ROW;
            if !name.is_empty() {
                scene.labels.push(Label {
                    text: name.clone(),
                    rect: BoxRect {
                        x: PAD,
                        y: (section_top + section_bottom - TEXT * 1.5) / 2.,
                        w: names - 8.,
                        h: TEXT * 1.5,
                    },
                    left: true,
                    ..Default::default()
                });
            }
            if next.is_some() {
                scene
                    .rules
                    .push([(PAD, section_bottom), (left + chart_width, section_bottom)]);
            }
            section_start = index + 1;
        }
        let color = if task.crit { 6 } else { task.section };
        let start = x(task.start);
        // Where the bar or milestone starts and ends.
        let (start, end) = if task.milestone {
            let size = BAR * 0.8;
            let center = x(task.start + (task.end - task.start) / 2.);
            scene.boxes.push(BoxRect {
                x: center - size / 2.,
                y: y + (BAR - size) / 2.,
                w: size,
                h: size,
            });
            scene.shapes.push(Shape::Diamond);
            (center - size / 2., center + size / 2.)
        } else {
            let w = (x(task.end) - start).max(2.);
            scene.swatches.push((
                BoxRect {
                    x: start,
                    y,
                    w,
                    h: BAR,
                },
                color,
            ));
            (start, start + w)
        };
        let natural = width_of(&task.name) + 4.;
        let fits = !task.milestone && natural + 8. <= end - start;
        // A name too long for its bar goes after it, else before it, else on
        // the roomier side, where it shrinks to fit inside the chart.
        let after = left + chart_width - end - 6.;
        let before = start - 6. - left;
        let (label_x, w) = if fits {
            (start, end - start)
        } else if natural <= after || after >= before {
            (end + 6., natural.min(after).max(1.))
        } else {
            let w = natural.min(before).max(1.);
            (start - 6. - w, w)
        };
        scene.labels.push(Label {
            text: task.name.clone(),
            rect: BoxRect {
                x: label_x,
                y: y + (BAR - TEXT * 1.5) / 2.,
                w,
                h: TEXT * 1.5,
            },
            left: !fits,
            on_fill: fits.then_some(color),
            ..Default::default()
        });
    }
    // The axis: a rule under the rows and dates at whole-day steps far enough apart.
    let axis = top + rows * ROW + 4.;
    scene.rules.push([(left, axis), (left + chart_width, axis)]);
    let per_day = chart_width as f64 / span;
    let step = [
        1., 2., 7., 14., 28., 56., 91., 182., 365., 730., 1825., 3650.,
    ]
    .into_iter()
    .find(|&step| step * per_day >= f64::from(TICK))
    .unwrap_or(span);
    let mut day = first.ceil();
    while day <= last {
        let tick = x(day);
        scene.rules.push([(tick, axis), (tick, axis + 5.)]);
        let text = date(day as i64);
        let w = width_of(&text) + 4.;
        scene.labels.push(Label {
            text,
            rect: BoxRect {
                x: (tick - w / 2.).min(left + chart_width + PAD - w).max(PAD),
                y: axis + 8.,
                w,
                h: TEXT * 1.5,
            },
            ..Default::default()
        });
        day += step;
    }
    scene.width = left + chart_width + PAD;
    scene.height = axis + 8. + TEXT * 1.5 + PAD;
    scene
}
