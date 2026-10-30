//! Mixed-size prose shaping. The same painted fragments drive caret/IME hit tests.
use super::*;
pub(super) struct Fragment {
    pub at: usize,
    pub origin: Point<Pixels>,
    pub line: ShapedLine,
    pub size: f32,
    pub dotted: bool,
}
pub(super) struct RichLine {
    pub fragments: Vec<Fragment>,
    pub height: Pixels,
    pub line_height: Pixels,
}
impl RichLine {
    pub fn shape(row: &super::super::spec_document::Line, width: Pixels, window: &Window) -> Self {
        let mut fragments = vec![];
        let mut x = px(0.);
        let mut y = px(0.);
        let mut at = 0;
        for run in &row.runs {
            let font_size = if run.font.family == theme().font_mono {
                12.
            } else {
                row.size
            };
            let text = &row.display[at..at + run.len];
            for (local, word) in text.split_word_bound_indices() {
                let font_size = if word == "●" { 9. } else { font_size };
                let mut style = run.clone();
                style.len = word.len();
                if word == "●" {
                    style.color = row.note_color.into();
                }
                let shaped = window.text_system().shape_line(
                    word.to_owned().into(),
                    px(font_size),
                    &[style.clone()],
                    None,
                );
                if x > px(0.) && x + shaped.width > width {
                    x = px(0.);
                    y += px(row.height);
                }
                if shaped.width <= width {
                    let w = shaped.width;
                    fragments.push(Fragment {
                        at: at + local,
                        origin: point(x, y),
                        line: shaped,
                        size: font_size,
                        dotted: row.dotted.iter().any(|r| r.contains(&(at + local))),
                    });
                    x += w;
                } else {
                    for (offset, glyph) in word.grapheme_indices(true) {
                        style.len = glyph.len();
                        let shaped = window.text_system().shape_line(
                            glyph.to_owned().into(),
                            px(font_size),
                            &[style.clone()],
                            None,
                        );
                        if x > px(0.) && x + shaped.width > width {
                            x = px(0.);
                            y += px(row.height);
                        }
                        let w = shaped.width;
                        fragments.push(Fragment {
                            at: at + local + offset,
                            origin: point(x, y),
                            line: shaped,
                            size: font_size,
                            dotted: row
                                .dotted
                                .iter()
                                .any(|r| r.contains(&(at + local + offset))),
                        });
                        x += w;
                    }
                }
            }
            at += run.len;
        }
        Self {
            fragments,
            height: y + px(row.height),
            line_height: px(row.height),
        }
    }
    pub fn position(&self, index: usize) -> Option<Point<Pixels>> {
        self.fragments
            .iter()
            .rev()
            .find(|f| index >= f.at)
            .map(|f| f.origin + point(f.line.x_for_index((index - f.at).min(f.line.len())), px(0.)))
    }
    pub fn index(&self, p: Point<Pixels>) -> usize {
        let line = (f32::from(p.y).max(0.) / f32::from(self.line_height)).floor();
        let y = px(line * f32::from(self.line_height));
        let row = self
            .fragments
            .iter()
            .filter(|f| f.origin.y == y)
            .collect::<Vec<_>>();
        let Some(first) = row.first() else {
            return self
                .fragments
                .last()
                .map(|f| f.at + f.line.len())
                .unwrap_or(0);
        };
        if p.x <= first.origin.x {
            return first.at;
        }
        for f in &row {
            if p.x <= f.origin.x + f.line.width {
                return f.at + f.line.closest_index_for_x(p.x - f.origin.x);
            }
        }
        row.last().map(|f| f.at + f.line.len()).unwrap_or(0)
    }
    pub fn paint(&self, origin: Point<Pixels>, window: &mut Window, cx: &mut App) {
        for f in &self.fragments {
            let at = origin + f.origin;
            f.line
                .paint_background(at, self.line_height, window, cx)
                .expect("notes background");
            f.line
                .paint(at, self.line_height, window, cx)
                .expect("notes text");
            if f.dotted {
                let mut x = px(0.);
                while x < f.line.width {
                    window.paint_quad(fill(
                        Bounds::new(
                            at + point(x, self.line_height - px(3.)),
                            size(px(2.).min(f.line.width - x), px(1.)),
                        ),
                        theme().success,
                    ));
                    x += px(4.);
                }
            }
        }
    }
}
