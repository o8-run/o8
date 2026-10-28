use super::*;
use gpui::{TestAppContext, VisualTestContext};
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};

struct Fixture(Child, Client);
impl Fixture {
    fn new() -> Self {
        let mut child = Command::new("node")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args(["--import", "./scripts/register-server-only-stub.mjs", "--import", "tsx",
                "scripts/next/dev-server.ts", "--images"])
            .env("O8_NEXT_API_TOKEN", "fixture-image-history-bearer")
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let origin = lines.find_map(|line| {
            serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"].as_str().map(str::to_owned)
        }).expect("fixture origin");
        std::thread::spawn(move || for _ in lines {});
        Self(child, Client::authenticated(&origin, Some("fixture-image-history-bearer".into())).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|w, cx| { w.refresh(); w.draw(cx).clear(); });
}

#[gpui::test]
fn grid_image_history_decodes_user_and_assistant_images(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let session = fixture.1.sessions().unwrap().into_iter()
        .find(|s| s.id == "thoughts-image-fixture").unwrap();
    let file = std::env::temp_dir().join(format!("o8-image-grid-{}.json", fixture.0.id()));
    let options = crate::pane_layout::Options { size: 1, workspace: session.repo_path.unwrap(), file: file.clone() };
    options.save(&crate::pane_layout::Layout::new(1, ["llm-chat:thoughts-image-fixture".into()].into_iter())).unwrap();
    let (grid, cx) = cx.add_window_view(|w, cx| crate::pane_grid::Grid::new(fixture.1.clone(), options, w, cx));
    grid.update(cx, |g, cx| g.load(cx));
    cx.run_until_parked();
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    assert!(grid.read_with(cx, |g, _| g.panes[0].transcript.is_some()), "Grid must read real saved history");
    for selector in ["transcript-image-user-image-0", "transcript-image-assistant-image-0"] {
        let bounds = cx.debug_bounds(selector).expect("Grid image reaches retained paint");
        assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
        assert_eq!(bounds.size, size(px(80.), px(48.)), "Grid must paint decoded image dimensions, not Loading placeholders");
    }
    let reads: Value = fixture.1.get("/api/image-fixture", &[]).unwrap();
    assert_eq!(reads["reads"][reads["saved"].as_str().unwrap()], 1, "Grid shares the existing loader's deduplication");
    let _ = fs::remove_file(file);
}

#[gpui::test]
fn transcript_image_cache_prunes_session_switch_and_stream_trim(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (surface, cx) = cx.add_window_view(|w, cx| Surface::new(fixture.1.clone(), w, cx));
    surface.update(cx, |s, cx| { s.sessions = fixture.1.sessions().unwrap(); s.select("thoughts-image-fixture".into(), cx); });
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, _| s.images.borrow().values().any(|s| matches!(s, images::ImageState::Ready(_)))));
    surface.update(cx, |s, cx| {
        let id = s.sessions.iter().find(|s| s.id != "thoughts-image-fixture" && s.message_count > 0).unwrap().id.clone();
        s.select(id, cx);
        assert!(s.images.borrow().is_empty(), "session switch must discard decoded images immediately");
    });
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, _| s.images.borrow().is_empty()));
    surface.update(cx, |s, cx| s.select("thoughts-image-fixture".into(), cx));
    cx.run_until_parked();
    surface.update(cx, |s, cx| {
        let t = s.transcript.as_mut().unwrap();
        let entries: Vec<_> = (0..201).map(|i| json!({"id":format!("text-{i}"),"role":"user","text":"Text after images"})).collect();
        assert!(t.apply(&json!({"channel":"realtime", "event":"batch", "data":{"events":[{
            "stream":format!("session:{}", t.key), "seq":1, "event":"history.snapshot",
            "data":{"sessionKey":t.key,"entries":entries,"replace":false}
        }]}})));
        assert_eq!(t.entries.len(), 200, "use the production stream retention bound");
        assert!(t.rows.iter().all(|r| images::paths(r).is_empty()));
        let rows = t.rows.clone();
        s.install_rows(rows, cx);
        assert!(s.images.borrow().is_empty(), "stream trimming must drop every unreferenced image");
    });
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, _| s.images.borrow().is_empty()), "late completions must not resurrect discarded images");
}
