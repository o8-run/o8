use super::*;
use gpui::{TestAppContext, VisualTestContext};
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};

struct Fixture(Child, Client);
impl Fixture {
    fn new() -> Self {
        let mut child = Command::new("node")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/dev-server.ts",
                "--images",
            ])
            .env("O8_NEXT_API_TOKEN", "fixture-image-history-bearer")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let origin = lines
            .find_map(|line| {
                serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("fixture origin");
        std::thread::spawn(move || for _ in lines {});
        Self(
            child,
            Client::authenticated(&origin, Some("fixture-image-history-bearer".into())).unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|w, cx| {
        w.refresh();
        w.draw(cx).clear();
    });
}

#[gpui::test]
fn grid_image_history_decodes_user_and_assistant_images(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let session = fixture
        .1
        .sessions()
        .unwrap()
        .into_iter()
        .find(|s| s.id == "thoughts-image-fixture")
        .unwrap();
    let file = std::env::temp_dir().join(format!("o8-image-grid-{}.json", fixture.0.id()));
    let options = crate::pane_layout::Options {
        size: 1,
        workspace: session.repo_path.unwrap(),
        file: file.clone(),
    };
    options
        .save(&crate::pane_layout::Layout::new(
            1,
            ["llm-chat:thoughts-image-fixture".into()].into_iter(),
        ))
        .unwrap();
    let (grid, cx) =
        cx.add_window_view(|w, cx| crate::pane_grid::Grid::new(fixture.1.clone(), options, w, cx));
    grid.update(cx, |g, cx| g.load(cx));
    cx.run_until_parked();
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    assert!(
        grid.read_with(cx, |g, _| g.panes[0].transcript.is_some()),
        "Grid must read real saved history"
    );
    for selector in [
        "transcript-image-user-image-0",
        "transcript-image-assistant-image-0",
    ] {
        let bounds = cx
            .debug_bounds(selector)
            .expect("Grid image reaches retained paint");
        assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
        assert_eq!(
            bounds.size,
            size(px(80.), px(48.)),
            "Grid must paint decoded image dimensions, not Loading placeholders"
        );
    }
    let reads: Value = fixture.1.get("/api/image-fixture", &[]).unwrap();
    assert_eq!(
        reads["reads"][reads["saved"].as_str().unwrap()],
        1,
        "Grid shares the existing loader's deduplication"
    );
    let _ = fs::remove_file(file);
}

#[gpui::test]
fn transcript_image_cache_prunes_session_switch_and_stream_trim(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (surface, cx) = cx.add_window_view(|w, cx| Surface::new(fixture.1.clone(), w, cx));
    surface.update(cx, |s, cx| {
        s.sessions = fixture.1.sessions().unwrap();
        s.select("thoughts-image-fixture".into(), cx);
    });
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, _| {
        s.images
            .borrow()
            .values()
            .any(|s| matches!(s, images::ImageState::Ready(_)))
    }));
    surface.update(cx, |s, cx| {
        let id = s
            .sessions
            .iter()
            .find(|s| s.id != "thoughts-image-fixture" && s.message_count > 0)
            .unwrap()
            .id
            .clone();
        s.select(id, cx);
        assert!(
            s.images.borrow().is_empty(),
            "session switch must discard decoded images immediately"
        );
    });
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, _| s.images.borrow().is_empty()));
    surface.update(cx, |s, cx| s.select("thoughts-image-fixture".into(), cx));
    cx.run_until_parked();
    surface.update(cx, |s, cx| {
        let t = s.transcript.as_mut().unwrap();
        let entries: Vec<_> = (0..201)
            .map(|i| json!({"id":format!("text-{i}"),"role":"user","text":"Text after images"}))
            .collect();
        assert!(t.apply(
            &json!({"channel":"realtime", "event":"batch", "data":{"events":[{
                "stream":format!("session:{}", t.key), "seq":1, "event":"history.snapshot",
                "data":{"sessionKey":t.key,"entries":entries,"replace":false}
            }]}})
        ));
        assert_eq!(
            t.entries.len(),
            200,
            "use the production stream retention bound"
        );
        assert!(t.rows.iter().all(|r| images::paths(r).is_empty()));
        let rows = t.rows.clone();
        s.install_rows(rows, cx);
        assert!(
            s.images.borrow().is_empty(),
            "stream trimming must drop every unreferenced image"
        );
    });
    cx.run_until_parked();
    assert!(
        surface.read_with(cx, |s, _| s.images.borrow().is_empty()),
        "late completions must not resurrect discarded images"
    );
}

#[gpui::test]
fn transcript_image_cache_bounds_working_set_and_reloads_after_scroll(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (surface, cx) = cx.add_window_view(|w, cx| Surface::new(fixture.1.clone(), w, cx));
    surface.update(cx, |s, cx| {
        s.sessions = fixture.1.sessions().unwrap();
        s.select("thoughts-image-fixture".into(), cx);
    });
    cx.run_until_parked();
    let reads: Value = fixture.1.get("/api/image-fixture", &[]).unwrap();
    let saved = std::path::Path::new(reads["saved"].as_str().unwrap());
    let path = saved.parent().unwrap().to_str().unwrap();
    let name = saved.file_name().unwrap().to_str().unwrap();
    // Distinct spellings of one real allowed fixture image exercise the bound
    // without changing the production media route or manufacturing decodes.
    let template = surface.read_with(cx, |s, _| {
        s.rows
            .iter()
            .find(|r| r.borrow().row.id() == "user-image")
            .unwrap()
            .borrow()
            .row
            .clone()
    });
    let rows: Vec<_> = (0..images::CAPACITY + 8)
        .map(|index| {
            let mut row = template.clone();
            if let Row::Message { id, nodes, .. } = &mut row {
                *id = if index == images::CAPACITY + 7 {
                    "bounded-last".into()
                } else {
                    format!("bounded-{index}")
                };
                for node in nodes {
                    if let Some(data) = &mut node.data {
                        if node.kind == "media" && data["kind"] == "image" {
                            data["path"] =
                                json!(format!("{path}/{}{name}", "./".repeat(index + 1)));
                        }
                    }
                }
            }
            row
        })
        .collect();
    surface.update(cx, |s, cx| {
        s.install_rows(rows, cx);
        s.list.scroll_to(ListOffset {
            item_ix: 0,
            offset_in_item: px(0.),
        });
        cx.notify();
    });
    cx.run_until_parked();
    draw(cx);
    surface.read_with(cx, |s, _| {
        assert_eq!(s.images.borrow().len(), images::CAPACITY);
        assert!(
            s.images
                .borrow()
                .values()
                .all(|state| matches!(state, images::ImageState::Ready(_)))
        );
    });
    surface.update(cx, |s, cx| {
        s.navigate(true, cx);
        cx.notify();
    });
    draw(cx);
    cx.run_until_parked();
    // Decoded heights replace 18px placeholders; bring the tail into the
    // viewport again after that layout change before checking painted bounds.
    surface.update(cx, |s, cx| s.navigate(true, cx));
    draw(cx);
    let selector = "transcript-image-bounded-last-0";
    assert_eq!(
        cx.debug_bounds(selector)
            .expect("scrolled image must paint")
            .size,
        size(px(80.), px(48.))
    );
    surface.read_with(cx, |s, _| {
        assert_eq!(s.images.borrow().len(), images::CAPACITY)
    });
    // Evicted images must be loadable again, rather than permanent placeholders.
    surface.update(cx, |s, cx| {
        s.navigate(false, cx);
        cx.notify();
    });
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        cx.debug_bounds("transcript-image-bounded-0-0")
            .unwrap()
            .size,
        size(px(80.), px(48.))
    );
    // Drop the working set while fresh requests are in flight. Their results
    // must not extend the cache after its rows have gone.
    surface.update(cx, |s, cx| {
        let mut rows = s
            .rows
            .iter()
            .map(|r| r.borrow().row.clone())
            .collect::<Vec<_>>();
        if let Row::Message { nodes, .. } = &mut rows[0] {
            for node in nodes {
                if let Some(data) = &mut node.data {
                    if node.kind == "media" {
                        data["path"] = json!(format!(
                            "{path}/{}{name}",
                            "./".repeat(images::CAPACITY + 20)
                        ));
                    }
                }
            }
        }
        s.install_rows(rows, cx);
        s.install_rows(vec![], cx);
        assert!(s.images.borrow().is_empty());
    });
    cx.run_until_parked();
    assert!(surface.read_with(cx, |s, _| s.images.borrow().is_empty()));
}

#[gpui::test]
fn transcript_image_wide_user_picture_stays_inside_bubble_and_aligns_with_text(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let (surface, cx) = cx.add_window_view(|w, cx| Surface::new(fixture.1.clone(), w, cx));
    cx.simulate_resize(size(px(1680.), px(1050.)));
    surface.update(cx, |s, cx| {
        s.sessions = fixture.1.sessions().unwrap();
        s.select("thoughts-image-fixture".into(), cx);
    });
    cx.run_until_parked();
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    let image = cx
        .debug_bounds("transcript-image-user-image-0")
        .expect("the real history image must reach retained prepaint");
    assert_eq!(image.size, size(px(80.), px(48.)), "use the decoded image");
    let row = surface.read_with(cx, |s, _| {
        s.rows
            .iter()
            .find(|row| row.borrow().row.id() == "user-image")
            .unwrap()
            .clone()
    });
    let geometry = row.borrow().painted_geometry.borrow().clone();
    assert!(geometry.row.size.width > px(1200.), "exercise a wide row");
    let bubble = geometry.backdrop.expect("painted user backdrop");
    let text = geometry.text_origin.expect("painted user text");
    println!(
        "WIDE_IMAGE_GEOMETRY row={:?} bubble={bubble:?} image={image:?} text={text:?}",
        geometry.row
    );
    assert!(
        image.left() >= bubble.left()
            && image.right() <= bubble.right()
            && image.top() >= bubble.top()
            && image.bottom() <= bubble.bottom(),
        "wide transcript image must stay inside its user bubble: image={image:?}, bubble={bubble:?}"
    );
    assert_eq!(
        image.left(),
        text.x,
        "image and bubble text must share a left edge"
    );
}
