use super::*;
use crate::shell::test_support::*;
struct TextWrapTests;
register_shell_feature!(TextWrapTests);
impl ShellFeature for TextWrapTests {}

#[gpui::test]
fn text_wrap_keeps_closing_punctuation_with_preceding_text(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("punctuation.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.update(|window, _| {
        for mark in [';', ':', ',', '.', '!', '?', ')', ']', '}', '\'', '"', '’', '”', '»', '›', '）', '］', '｝', '。', '、', '！', '？', '」', '』', '】'] {
            for text in [format!("first final{mark} next word"), format!("first final {mark} next word"), format!("first abcdefghijklmnopqrstuvwxyz{mark}{mark} next word"), format!("first café界{mark} next word"), format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa{mark} continuation"), format!("first final{mark}   \t continuation")] {
                for family in [theme().font_ui, theme().font_mono] {
                    let mut style = window.text_style();
                    style.font_family = family.into();
                    let runs = [style.to_run(text.len())];
                    for width in (8..240).step_by(3) {
                        let lines = window.text_system().shape_text(text.clone().into(), px(14.), &runs, Some(px(width as f32)), None).unwrap();
                        assert_eq!(lines.iter().map(|line| line.text.as_ref()).collect::<String>(), text);
                        for line in lines {
                            for boundary in line.wrap_boundaries() {
                                let glyph = &line.runs()[boundary.run_ix].glyphs[boundary.glyph_ix];
                                let start = &line.text[glyph.index..];
                                assert!(!start.starts_with(char::is_whitespace), "wrap-point whitespace starts a soft line at width {width} in {text:?}: {start:?}");
                                assert!(!start.starts_with(mark), "closing {mark:?} starts a soft line at width {width} in {text:?}: {start:?}");
                            }
                        }
                    }
                }
            }
        }
        // Opening quotes can still travel with the following word.
        for quote in ['\'', '"', '“'] {
            let text = format!("first {quote}quoted word");
            let runs = [window.text_style().to_run(text.len())];
            let mut opening_starts_line = false;
            for width in 24..120 {
                for line in window.text_system().shape_text(text.clone().into(), px(14.), &runs, Some(px(width as f32)), None).unwrap() {
                    for boundary in line.wrap_boundaries() {
                        let glyph = &line.runs()[boundary.run_ix].glyphs[boundary.glyph_ix];
                        opening_starts_line |= line.text[glyph.index..].starts_with(quote);
                    }
                }
            }
            assert!(opening_starts_line, "opening {quote:?} must remain an allowed word boundary");
        }
    });
}
