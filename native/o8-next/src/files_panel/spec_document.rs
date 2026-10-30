//! O8SpecEditor's editable Markdown metrics and byte-preserving display projection.
use crate::theme::current as theme;
use gpui::*;
use std::{ops::Range, sync::LazyLock};
pub(super) struct Line {
    pub start: usize,
    pub len: usize,
    pub display: SharedString,
    pub map: Vec<(usize, usize)>,
    pub size: f32,
    pub height: f32,
    pub runs: Vec<TextRun>,
}
pub(super) fn lines(
    source: &str,
    selection: &Range<usize>,
    marked: Option<&Range<usize>>,
    accent: Rgba,
) -> Vec<Line> {
    let mut offset = 0;
    let mut fenced = false;
    source
        .split('\n')
        .map(|raw| {
            if raw.trim_start().starts_with("```") || raw.trim_start().starts_with("~~~") {
                fenced = !fenced;
            }
            let hashes = raw.bytes().take_while(|b| *b == b'#').count();
            let heading = if !fenced
                && (1..=6).contains(&hashes)
                && raw.as_bytes().get(hashes) == Some(&b' ')
            {
                hashes
            } else {
                0
            };
            let skip = if heading > 0 { heading + 1 } else { 0 };
            let size = match heading {
                1 => 18.,
                2 => 10.,
                _ => 13.5,
            };
            let weight = if heading == 1 || heading >= 3 {
                FontWeight::NORMAL
            } else {
                FontWeight::LIGHT
            };
            let color = match heading {
                2 => theme().text_faint,
                3.. => theme().text_secondary,
                _ => theme().text,
            };
            let mut display = String::new();
            let mut map = vec![(0, 0)];
            for (at, ch) in raw.char_indices() {
                if at >= skip {
                    if heading == 2 {
                        display.extend(ch.to_uppercase());
                    } else if ch == '\t' {
                        display.push_str("  ");
                    } else {
                        display.push(ch);
                    }
                }
                map.push((at + ch.len_utf8(), display.len()));
            }
            if display.is_empty() {
                display.push(' ');
            }
            static STRONG: LazyLock<regex::Regex> =
                LazyLock::new(|| regex::Regex::new(r"\*\*[^*]+\*\*|__[^_]+__").unwrap());
            static EMPH: LazyLock<regex::Regex> =
                LazyLock::new(|| regex::Regex::new(r"\*[^*]+\*|_[^_]+_").unwrap());
            static CODE: LazyLock<regex::Regex> =
                LazyLock::new(|| regex::Regex::new(r"`[^`]+`").unwrap());
            static LINK: LazyLock<regex::Regex> =
                LazyLock::new(|| regex::Regex::new(r"\[[^\]]+\]\([^\)]+\)").unwrap());
            let raw_at = |index: usize| {
                map.iter()
                    .rev()
                    .find(|(_, d)| *d <= index)
                    .map(|(r, _)| *r)
                    .unwrap_or(0)
                    + offset
            };
            let strong = STRONG
                .find_iter(&display)
                .map(|m| m.range())
                .collect::<Vec<_>>();
            let emph = EMPH
                .find_iter(&display)
                .map(|m| m.range())
                .collect::<Vec<_>>();
            let code = CODE
                .find_iter(&display)
                .map(|m| m.range())
                .collect::<Vec<_>>();
            let links = LINK
                .find_iter(&display)
                .map(|m| m.range())
                .collect::<Vec<_>>();
            let mut boundaries = vec![0, display.len()];
            for list in [&strong, &emph, &code, &links] {
                for range in list {
                    boundaries.extend([range.start, range.end]);
                }
            }
            for (raw, display) in &map {
                if selection.start == offset + raw
                    || selection.end == offset + raw
                    || marked.is_some_and(|r| r.start == offset + raw || r.end == offset + raw)
                {
                    boundaries.push(*display);
                }
            }
            boundaries.sort_unstable();
            boundaries.dedup();
            let runs = boundaries
                .windows(2)
                .map(|span| {
                    let code = fenced || code.iter().any(|r| r.contains(&span[0]));
                    let link = links.iter().any(|r| r.contains(&span[0]));
                    let mut font = font(if code {
                        theme().font_mono
                    } else {
                        theme().font_ui
                    });
                    font.weight = if strong.iter().any(|r| r.contains(&span[0])) {
                        FontWeight::MEDIUM
                    } else {
                        weight
                    };
                    if !code && emph.iter().any(|r| r.contains(&span[0])) {
                        font.style = FontStyle::Italic;
                    }
                    TextRun {
                        len: span[1] - span[0],
                        font,
                        color: if link { accent.into() } else { color.into() },
                        background_color: selection
                            .contains(&raw_at(span[0]))
                            .then(|| theme().selection.into()),
                        underline: (link || marked.is_some_and(|r| r.contains(&raw_at(span[0]))))
                            .then_some(UnderlineStyle {
                                thickness: px(1.),
                                color: None,
                                wavy: false,
                            }),
                        strikethrough: None,
                    }
                })
                .collect();
            let line = Line {
                start: offset,
                len: raw.len(),
                display: display.into(),
                map,
                size: if fenced { 12. } else { size },
                height: size * 1.55,
                runs,
            };
            offset += raw.len() + 1;
            line
        })
        .collect()
}
