//! File viewer interaction and geometry coverage.
use super::*;

const MARKDOWN_FIXTURE: &str = "# Readable heading\n\n- A list item\n\n```rust\nfn formatted() {}\n```\n\n| Name | Value |\n| --- | --- |\n| *emphasis* | [link](https://example.com) |\n";

pub(super) fn viewer_markdown_opens_formatted_heading_list_and_code(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("AGENTS.md"),
        MARKDOWN_FIXTURE,
    )
    .unwrap();
    fs::write(
        PathBuf::from(&fixture.repo).join("guide.mdx"),
        MARKDOWN_FIXTURE,
    )
    .unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    assert!(cx.debug_bounds("files-source-1").is_none());
    let (nodes, rendered) = panel.read_with(cx, |_, cx| {
        let state = cx
            .try_global::<RenderedMarkdown>()
            .expect("Files must mount transcript Markdown")
            .0
            .borrow();
        let crate::model::Row::Message { nodes, .. } = &state.row else {
            panic!("formatted document row")
        };
        (
            nodes.clone(),
            cx.global::<markdown_tests::DocumentView>()
                .text
                .iter()
                .map(|(_, text)| text.text())
                .collect::<Vec<_>>(),
        )
    });
    assert!(rendered.iter().any(|line| line == "Readable heading"));
    assert!(rendered.iter().any(|line| line == "A list item"));
    assert!(rendered.iter().any(|line| line == "fn formatted() {}"));
    for kind in ["h1", "ul", "code-block", "table"] {
        assert!(
            nodes.iter().any(|n| n.kind == kind),
            "missing formatted {kind}"
        );
    }
    assert!(cx.debug_bounds("files-markdown-1").unwrap().size.height > px(100.));
    click(cx, "files-row-guide.mdx");
    wait(cx, "files-markdown-2");
    assert!(cx.debug_bounds("files-source-2").is_none());
}

pub(super) fn viewer_preview_source_toggle_remembers_each_file(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("AGENTS.md"),
        MARKDOWN_FIXTURE,
    )
    .unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    click(cx, "files-source-toggle");
    wait(cx, "files-source-1");
    click(cx, "files-row-PARITY-BOARD.local.md");
    wait(cx, "files-markdown-2");
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-source-3");
    assert!(cx.debug_bounds("files-markdown-3").is_none());
    click(cx, "files-preview-toggle");
    wait(cx, "files-markdown-3");
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected.clone()).as_deref(),
        Some("AGENTS.md")
    );
}

pub(super) fn viewer_long_source_line_wraps_and_reflows_at_panel_width(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    // Include indentation, Unicode, and an unbroken token as well as words.
    let line = format!(
        "    let readable = {:?}; // {}",
        "wrapped text λ ".repeat(30),
        "x".repeat(180)
    );
    fs::write(PathBuf::from(&fixture.repo).join("src/useful.rs"), &line).unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-source-line-1-0");
    click(cx, "files-tree-toggle");
    cx.simulate_resize(gpui::size(px(700.), px(700.)));
    draw(cx);
    let narrow = cx.debug_bounds("files-source-line-1-0").unwrap();
    let panel = cx.debug_bounds("files-source-1").unwrap();
    assert!(narrow.size.height > px(19.), "long source line must wrap");
    assert!(
        narrow.size.width <= panel.size.width,
        "wrapped line must fit panel"
    );
    cx.simulate_resize(gpui::size(px(1200.), px(700.)));
    draw(cx);
    let wide = cx.debug_bounds("files-source-line-1-0").unwrap();
    assert!(wide.size.width > narrow.size.width);
    assert!(
        wide.size.height < narrow.size.height,
        "resize must reflow existing rows"
    );
    click(cx, "files-wrap-toggle");
    let unwrapped = cx.debug_bounds("files-source-line-1-0").unwrap();
    assert_eq!(unwrapped.size.height, px(19.));
    assert!(
        unwrapped.size.width > wide.size.width,
        "unwrapped source can scroll horizontally"
    );
    click(cx, "files-wrap-toggle");
    assert_eq!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height,
        wide.size.height
    );
}

pub(super) fn viewer_plain_text_wraps_by_default_and_toggle_works_from_keyboard(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("notes.txt"),
        "A readable long line of plain text. ".repeat(70),
    )
    .unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-notes.txt");
    wait(cx, "files-source-line-1-0");
    assert!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height
            > px(19.)
    );
    click(cx, "files-wrap-toggle");
    assert_eq!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height,
        px(19.)
    );
    cx.simulate_keystrokes("space");
    draw(cx);
    assert!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height
            > px(19.)
    );
}

pub(super) fn viewer_header_filename_and_folder_truncate_independently(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = format!(
        "src/{}/{}.txt",
        "nested-folder-".repeat(10),
        "long-filename-".repeat(10)
    );
    let file = PathBuf::from(&fixture.repo).join(&path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, "readable").unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    panel.update(cx, |panel, cx| panel.open_file(path.clone(), cx));
    wait(cx, "files-source-line-1-0");
    cx.simulate_resize(gpui::size(px(700.), px(700.)));
    draw(cx);
    let name = cx.debug_bounds("files-viewer-name").unwrap();
    let folder = cx.debug_bounds("files-viewer-folder").unwrap();
    assert_eq!(name.size.height, px(17.));
    assert_eq!(folder.size.height, px(12.));
    assert!(folder.top() >= name.bottom());
    assert_eq!(name.size.width, folder.size.width);
    assert!(
        name.size.width < px(500.),
        "both long strings must ellipsize inside the narrow header"
    );
    assert!(name.size.width > px(0.));
    let (name_text, folder_text) = panel.read_with(cx, |_, cx| {
        let heading = cx.global::<HeadingLayouts>();
        (heading.name.text(), heading.folder.text())
    });
    assert!(
        name_text.ends_with('…') && name_text.chars().count() > 5,
        "show filename characters before the ellipsis: {name_text}"
    );
    assert!(folder_text.ends_with('…') && folder_text.chars().count() > 5);
    cx.simulate_resize(gpui::size(px(1200.), px(700.)));
    draw(cx);
    let wider = panel.read_with(cx, |_, cx| cx.global::<HeadingLayouts>().name.text());
    assert!(
        wider.chars().count() > name_text.chars().count(),
        "title must remeasure when available width grows"
    );
}

const PNG_FIXTURE: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=";
const SVG_FIXTURE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64"><rect x="8" y="8" width="80" height="48" fill="#0088ff"/></svg>"##;

pub(super) fn viewer_svg_defaults_to_preview_and_switches_to_wrapped_source(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    fs::write(PathBuf::from(&fixture.repo).join("vector.svg"), SVG_FIXTURE).unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-vector.svg");
    wait(cx, "files-media-1");
    let card = cx.debug_bounds("files-image-card").unwrap();
    assert_eq!(
        card.size,
        gpui::size(px(134.), px(102.)),
        "natural SVG size plus classic's 18px padding and border"
    );
    let pixel = panel.read_with(cx, |_, cx| {
        let image = &cx.global::<RenderedMedia>().0;
        let width = image.size(0).width.0 as usize;
        let x = width * 10 / 96;
        let y = image.size(0).height.0 as usize * 10 / 64;
        let at = (y * width + x) * 4;
        image.as_bytes(0).unwrap()[at..at + 4].to_vec()
    });
    assert_eq!(
        pixel,
        [255, 136, 0, 255],
        "SVG #0088ff must reach the BGRA atlas without swapping red and blue"
    );
    click(cx, "files-source-toggle");
    wait(cx, "files-source-line-1-0");
    click(cx, "files-tree-toggle");
    cx.simulate_resize(gpui::size(px(400.), px(600.)));
    draw(cx);
    assert!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height
            > px(19.)
    );
    click(cx, "files-preview-toggle");
    draw(cx);
    assert!(cx.debug_bounds("files-media-1").is_some());
}

pub(super) fn viewer_raster_image_uses_checked_asset_route_and_contained_card(
    cx: &mut TestAppContext,
) {
    use base64::Engine;
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("picture.png"),
        base64::engine::general_purpose::STANDARD
            .decode(PNG_FIXTURE)
            .unwrap(),
    )
    .unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-picture.png");
    wait(cx, "files-media-1");
    assert_eq!(
        cx.debug_bounds("files-image-card").unwrap().size,
        gpui::size(px(40.), px(39.))
    );
    let requests = fixture.requests();
    assert!(
        requests
            .iter()
            .any(|r| r.contains("/api/panel/file-asset?path=picture.png"))
    );
    assert!(
        !requests
            .iter()
            .any(|r| r.contains("/api/v2/files?path=picture.png")),
        "binary images never use the text endpoint"
    );
}

pub(super) fn viewer_failed_svg_keeps_source_available_and_retry_recovers(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("broken.svg");
    fs::write(&path, "<svg invalid").unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-broken.svg");
    wait(cx, "files-load-error");
    click(cx, "files-source-toggle");
    wait(cx, "files-source-line-1-0");
    click(cx, "files-preview-toggle");
    fs::write(&path, SVG_FIXTURE).unwrap();
    click(cx, "files-retry");
    wait(cx, "files-media-2");
}
