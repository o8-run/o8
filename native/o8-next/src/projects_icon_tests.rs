//! The Projects page's icon picker through real pointer and text input, the
//! update-icon route and the reloaded repository listing.
use super::*;

fn icon(fixture: &Fixture) -> Value {
    repos(fixture)[0]["icon"].clone()
}
fn shown(cx: &mut VisualTestContext, mark: String) -> bool {
    draw(cx);
    cx.debug_bounds(Box::leak(mark.into_boxed_str())).is_some()
}
/// The repository's own monogram, as the sidebar's identity draws it.
fn monogram(name: &str) -> String {
    name.split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter_map(|word| word.chars().next())
        .take(2)
        .flat_map(char::to_uppercase)
        .collect()
}

#[gpui::test]
fn projects_repository_icon_picker_saves_each_choice(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "");
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({"action":"add","localPath":fixture.folders[0]}),
        )
        .unwrap();
    let name = repos(&fixture)[0]["name"].as_str().unwrap().to_owned();
    let (_shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("icons.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "rail-more");
    click(cx, "rail-more-projects");
    assert_eq!(icon(&fixture), Value::Null);
    assert!(shown(cx, format!("repo-identity-0:{}", monogram(&name))));

    // An emoji from the grid.
    click(cx, "repo-icon-0");
    click(cx, "repo-icon-mode-emoji");
    click(cx, "repo-icon-emoji-2");
    click(cx, "repo-icon-save");
    assert_eq!(icon(&fixture), json!({"kind":"emoji","emoji":"🚀"}));
    assert!(shown(cx, "repo-identity-0:emoji:🚀".into()));
    assert!(cx.debug_bounds("repo-icon-picker").is_none());

    // A pasted emoji; the picker reopens on the Emoji tab.
    click(cx, "repo-icon-0");
    fill(cx, "repo-icon-custom-emoji", "🦀 crab");
    click(cx, "repo-icon-save");
    assert_eq!(icon(&fixture), json!({"kind":"emoji","emoji":"🦀"}));

    // A glyph found by search, in a color.
    click(cx, "repo-icon-0");
    click(cx, "repo-icon-mode-glyph");
    fill(cx, "repo-icon-search", "rock");
    assert!(cx.debug_bounds("repo-icon-glyph-terminal").is_none());
    click(cx, "repo-icon-glyph-rocket");
    click(cx, "repo-icon-color-violet");
    click(cx, "repo-icon-save");
    assert_eq!(
        icon(&fixture),
        json!({"kind":"glyph","name":"rocket","color":"violet"})
    );
    assert!(shown(cx, "repo-identity-0:glyph:rocket:violet".into()));

    // A monogram: three letters cannot be saved; two can.
    click(cx, "repo-icon-0");
    click(cx, "repo-icon-mode-monogram");
    fill(cx, "repo-icon-letters", "abc");
    click(cx, "repo-icon-save");
    assert_eq!(icon(&fixture)["kind"], "glyph");
    fill(cx, "repo-icon-letters", "q2");
    assert!(cx.debug_bounds("repo-icon-preview:Q2").is_some());
    click(cx, "repo-icon-color-teal");
    click(cx, "repo-icon-save");
    assert_eq!(
        icon(&fixture),
        json!({"kind":"monogram","text":"Q2","color":"teal"})
    );
    assert!(shown(cx, "repo-identity-0:monogram:Q2:teal".into()));

    // An image path: one outside the repository is refused and the picker
    // stays; one inside is saved and replaces the identity override.
    let brand = std::path::Path::new(&fixture.folders[0]).join("brand");
    fs::create_dir_all(&brand).unwrap();
    fs::write(brand.join("icon.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    click(cx, "repo-icon-0");
    click(cx, "repo-icon-mode-image");
    fill(cx, "repo-icon-path", "../outside.png");
    click(cx, "repo-icon-save");
    assert!(cx.debug_bounds("projects-error").is_some());
    assert!(cx.debug_bounds("repo-icon-picker").is_some());
    assert_eq!(icon(&fixture)["kind"], "monogram");
    fill(cx, "repo-icon-path", "brand/icon.png");
    click(cx, "repo-icon-save");
    assert_eq!(icon(&fixture)["kind"], "image");
    assert_eq!(icon(&fixture)["path"], "brand/icon.png");
    // Without the image route (#5135) the repository's monogram stands in.
    assert!(shown(cx, format!("repo-identity-0:{}", monogram(&name))));

    // Use automatic clears both choices; a choice survives a reload.
    click(cx, "repo-icon-0");
    click(cx, "repo-icon-automatic");
    assert_eq!(icon(&fixture), Value::Null);
    click(cx, "repo-icon-0");
    click(cx, "repo-icon-mode-emoji");
    click(cx, "repo-icon-emoji-0");
    click(cx, "repo-icon-save");
    click(cx, "projects-refresh");
    assert!(shown(cx, "repo-identity-0:emoji:💻".into()));
}
