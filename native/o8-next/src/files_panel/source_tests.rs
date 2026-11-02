//! Observe the text and syntax spans actually mounted by the source viewer.
use super::*;
use gpui::Rgba;
use std::ops::Range;
#[derive(Default)]
pub(in crate::files_panel) struct Painted(pub Vec<(String, Vec<(Range<usize>, Rgba)>)>, pub bool);
impl gpui::Global for Painted {}
pub(in crate::files_panel) struct SyntaxFault(pub bool);
impl gpui::Global for SyntaxFault {}
fn painted(cx: &mut VisualTestContext) -> Vec<(String, Vec<(Range<usize>, Rgba)>)> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        draw(cx);
        let rows = cx.update(|_, cx| {
            cx.try_global::<Painted>()
                .map(|p| p.0.clone())
                .unwrap_or_default()
        });
        if rows.iter().any(|(_, spans)| !spans.is_empty()) {
            return rows;
        }
        assert!(
            Instant::now() < deadline,
            "source must paint tree-sitter colors"
        );
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(super) fn colors(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("src/useful.rs"),
        "pub fn café() -> &'static str {\n  // a comment\n  \"café\"\n}\n",
    )
    .unwrap();
    fs::write(
        PathBuf::from(&fixture.repo).join("colors.ts"),
        "export const greeting = \"hello\";\nconst count = 42;\n",
    )
    .unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-source-1");
    let rows = painted(cx);
    assert!(rows.iter().any(|(text, spans)| {
        spans
            .iter()
            .any(|(r, c)| &text[r.clone()] == "pub" && *c == theme().syntax_keyword)
    }));
    assert!(rows.iter().any(|(text, spans)| {
        spans
            .iter()
            .any(|(r, c)| text[r.clone()].contains("café") && *c == theme().syntax_string)
    }));
    assert!(rows.iter().any(|(text, spans)| {
        spans
            .iter()
            .any(|(r, c)| text[r.clone()].contains("comment") && *c == theme().text_secondary)
    }));
    click(cx, "files-row-colors.ts");
    wait(cx, "files-source-2");
    let rows = painted(cx);
    assert!(rows.iter().any(|(text, spans)| {
        spans
            .iter()
            .any(|(r, c)| &text[r.clone()] == "const" && *c == theme().syntax_keyword)
    }));
    assert!(rows.iter().any(|(text, spans)| {
        spans
            .iter()
            .any(|(r, c)| text[r.clone()].contains("hello") && *c == theme().syntax_string)
    }));
    assert!(rows.iter().any(|(text, spans)| {
        spans
            .iter()
            .any(|(r, c)| &text[r.clone()] == "42" && *c == theme().syntax_emphasis)
    }));
}
pub(super) fn metrics(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("src/useful.rs"),
        "\tfn useful() {}\n",
    )
    .unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-source-1");
    let number = cx
        .debug_bounds("files-source-number-1-0")
        .expect("classic number column");
    let code = cx.debug_bounds("files-source-code-1-0").unwrap();
    assert_eq!(number.size.width, px(36.));
    assert_eq!(code.left() - number.right(), px(12.));
    let rows = painted(cx);
    assert!(rows.iter().any(|(s, _)| s == "  fn useful() {}"));
}
pub(super) fn retry(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = test_panel(&fixture, cx);
    panel.update(cx, |_, cx| cx.set_global(SyntaxFault(true)));
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-syntax-retry");
    assert!(
        cx.debug_bounds("files-source-line-1-0").is_some(),
        "plain source stays readable during syntax failure"
    );
    click(cx, "files-syntax-retry");
    painted(cx);
    draw(cx);
    assert!(
        !cx.update(|_, cx| cx.global::<Painted>().1),
        "successful retry removes syntax notice from the source render"
    );
}
