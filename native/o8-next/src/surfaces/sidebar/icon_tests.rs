//! Repository icon overrides from the listing on the real project header,
//! repository chips, scope picker and By repo folders.
use super::scope_tests::{press, project, repo_name};
use super::*;

fn icon(fixture: &Fixture, path: &str, patch: Value) {
    let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    let id = repos["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["localPath"] == path)
        .unwrap()["id"]
        .clone();
    let mut body = patch;
    body["action"] = json!("update-icon");
    body["id"] = id;
    fixture
        .client
        .project_request("POST", "/api/panel/repos", &body)
        .unwrap();
}
/// Waits for a marked identity to paint.
fn shown(cx: &mut VisualTestContext, mark: String) -> bool {
    let mark: &'static str = Box::leak(mark.into_boxed_str());
    for _ in 0..200 {
        draw(cx);
        if cx.debug_bounds(mark).is_some() {
            return true;
        }
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}
fn reload(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    shell.update(cx, |s, cx| {
        let sidebar = s.surfaces.sidebar.view.clone().unwrap();
        sidebar.update(cx, |l, cx| l.load(cx));
    });
}

#[gpui::test]
fn sidebar_draws_repository_icon_overrides(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar");
    let paths = [fixture.folders[0].clone(), fixture.folders[1].clone()];
    let id = project(&fixture, &paths);
    let names = [
        repo_name(&fixture, &paths[0]),
        repo_name(&fixture, &paths[1]),
    ];
    // A thread in each repository, so By repo has a folder for each.
    for (tab, path) in ["thoughts-composer-first", "thoughts-composer-second"]
        .iter()
        .zip(&paths)
    {
        fixture
            .client
            .project_request(
                "PATCH",
                "/api/v2/chat-history",
                &json!({"tabId":tab,"repoPath":path}),
            )
            .unwrap();
    }
    // The first repository chose an emoji; the second a glyph this build
    // lacks, which keeps its color on the derived monogram.
    icon(
        &fixture,
        &paths[0],
        json!({"projectIcon":{"kind":"emoji","emoji":"🚀"}}),
    );
    icon(
        &fixture,
        &paths[1],
        json!({"projectIcon":{"kind":"lucide","name":"atom","color":"violet"}}),
    );
    // project-two: P and T, by the listing's monogram rule and by T3's.
    let letters = "PT";
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("icons.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);

    // The header: the project shows its first repository's icon, and each
    // repository chip its own.
    assert!(shown(
        &mut visual,
        "sidebar-project-identity:emoji:🚀".into()
    ));
    assert!(shown(&mut visual, "sidebar-repo-identity:emoji:🚀".into()));
    assert!(shown(
        &mut visual,
        format!("sidebar-repo-identity:monogram:{letters}:violet")
    ));

    // The scope picker's items, and its trigger once scoped. Scoping keeps
    // each repository's folder near the top of the long fixture list.
    click(&mut visual, "sidebar-scope");
    assert!(shown(
        &mut visual,
        "sidebar-scope-item-identity:emoji:🚀".into()
    ));
    assert!(shown(
        &mut visual,
        format!("sidebar-scope-item-identity:monogram:{letters}:violet")
    ));
    press(
        &mut visual,
        &format!("sidebar-scope-item-{}", names[0]),
        gpui::Modifiers::default(),
    );
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_scope.get(&id) == Some(&vec![paths[0].clone()])
    });
    assert!(shown(&mut visual, "sidebar-scope-identity:emoji:🚀".into()));

    // By repo folders.
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-repo");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&id).map(String::as_str) == Some("repo")
    });
    assert!(shown(
        &mut visual,
        "sidebar-folder-identity:emoji:🚀".into()
    ));

    // An image draws the repository's monogram until the image route lands.
    let brand = std::path::Path::new(&paths[0]).join("brand");
    std::fs::create_dir_all(&brand).unwrap();
    std::fs::write(brand.join("icon.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    icon(
        &fixture,
        &paths[0],
        json!({"projectIcon":null,"faviconPath":"brand/icon.png"}),
    );
    reload(&shell, &mut visual);
    assert!(shown(&mut visual, "sidebar-folder-identity:PO".into()));
    draw(&mut visual);
    assert!(
        visual
            .debug_bounds("sidebar-folder-identity:emoji:🚀")
            .is_none()
    );

    // The second repository's folder and the scope trigger keep the missing
    // glyph's color.
    click(&mut visual, "sidebar-scope");
    press(
        &mut visual,
        &format!("sidebar-scope-item-{}", names[1]),
        gpui::Modifiers::default(),
    );
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_scope.get(&id) == Some(&vec![paths[1].clone()])
    });
    assert!(shown(
        &mut visual,
        format!("sidebar-folder-identity:monogram:{letters}:violet")
    ));
    assert!(shown(
        &mut visual,
        format!("sidebar-scope-identity:monogram:{letters}:violet")
    ));
}
