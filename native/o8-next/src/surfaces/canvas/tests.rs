use super::*;
use crate::shell::test_support::*;
use gpui::{Modifiers, MouseButton, ScrollDelta, ScrollWheelEvent, TouchPhase};

fn pump(v: &mut VisualTestContext, until: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        v.run_until_parked();
        if let Some(shell) = v.update(|w, _| w.root::<Shell>().flatten()) {
            shell.update_in(v, |s, w, cx| s.tick(false, w, cx));
        }
        draw(v);
        if until(v) {
            return;
        }
        assert!(Instant::now() < deadline, "canvas did not settle");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn click(v: &mut VisualTestContext, id: &'static str) {
    draw(v);
    let b = v.debug_bounds(id).unwrap_or_else(|| panic!("missing {id}"));
    v.simulate_click(b.center(), Modifiers::default());
    draw(v);
}
fn drag(v: &mut VisualTestContext, id: &'static str, delta: [f32; 2]) {
    draw(v);
    let from = v
        .debug_bounds(id)
        .unwrap_or_else(|| panic!("missing {id}"))
        .center();
    drag_from(v, from, delta);
}
fn drag_from(v: &mut VisualTestContext, from: gpui::Point<gpui::Pixels>, delta: [f32; 2]) {
    let to = from + point(px(delta[0]), px(delta[1]));
    v.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
    draw(v);
    v.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    draw(v);
}
fn layout(view: &Entity<View>, v: &VisualTestContext) -> model::Layout {
    view.read_with(v, |v, _| v.layout.clone())
}
fn open_canvas(
    f: &Fixture,
    cx: &mut TestAppContext,
    file: PathBuf,
    state: State,
) -> (Entity<Shell>, VisualTestContext, Entity<View>) {
    let (s, mut v) = open_past_setup(f.client.clone(), file, state, cx);
    pump(&mut v, |v| s.read_with(v, |s, _| s.connected));
    pump(&mut v, |v| s.read_with(v, |s, _| enabled(s)));
    // The same command-palette entry exposed to a person.
    v.simulate_keystrokes("ctrl-shift-p");
    v.simulate_input("Open Canvas");
    v.simulate_keystrokes("enter");
    draw(&mut v);
    let view = s
        .read_with(&v, |s, _| active(s))
        .expect("canvas opened by command");
    (s, v, view)
}
/// The canvas_mode toggle, through Symon's o8_ui_set frame.
fn toggle(s: &Entity<Shell>, v: &mut VisualTestContext, on: bool) {
    let frame = json!({"kind":"symon-ui","payload":{"data":{
        "surface":"set","key":"canvas_mode","value":if on { "on" } else { "off" }
    }}});
    s.update_in(v, |s, w, cx| s.ui_command(&frame, w, cx));
}
/// Wheel and pinch saves wait for the input to pause.
fn settle_saves(v: &mut VisualTestContext) {
    v.executor().advance_clock(Duration::from_millis(400));
    v.run_until_parked();
    draw(v);
}
fn saved(file: &std::path::Path, key: &str) -> model::Layout {
    State::load(file).unwrap().canvas_layouts[key].clone()
}
fn enable(f: &Fixture, on: bool) {
    f.client
        .project_request(
            "POST",
            "/api/panel/operator-defaults",
            &json!({"experimentalCanvas":on}),
        )
        .unwrap();
}

#[gpui::test]
fn canvas_input_moves_resizes_raises_closes_and_round_trips(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--onboarding --review");
    enable(&f, true);
    let file = f.root.join("canvas.json");
    let (s, mut v, view) = open_canvas(&f, cx, file.clone(), State::default());
    v.simulate_resize(size(px(2600.), px(1600.)));
    draw(&mut v);
    click(&mut v, "canvas-add-diff");
    pump(&mut v, |v| {
        v.debug_bounds("canvas-packet-next-review-approve")
            .is_some()
    });
    click(&mut v, "canvas-packet-next-review-approve");
    pump(&mut v, |v| {
        view.read_with(v, |p, cx| {
            p.diffs
                .get("next-review-approve")
                .is_some_and(|d| d.read(cx).ready)
        })
    });
    view.read_with(&v, |p, cx| {
        assert!(
            !p.diffs["next-review-approve"]
                .read(cx)
                .document
                .files
                .is_empty(),
            "existing native diff loads real packet patch"
        )
    });
    let first = layout(&view, &v).diff[0].rect;
    let key = s.read_with(&v, |s, _| {
        project_key(s, s.state.selected.as_deref().unwrap())
    });
    // Each move redraws; only the release saves.
    let header = v
        .debug_bounds("canvas-header-next-review-approve")
        .unwrap()
        .center();
    v.simulate_mouse_down(header, MouseButton::Left, Modifiers::default());
    for step in 1..=10 {
        let to = header + point(px(10. * step as f32), px(4. * step as f32));
        v.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
        draw(&mut v);
    }
    assert_eq!(layout(&view, &v).diff[0].rect, first.moved([100., 40.]));
    assert_eq!(saved(&file, &key).diff[0].rect, first, "no save mid-drag");
    v.simulate_mouse_up(
        header + point(px(100.), px(40.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    draw(&mut v);
    assert_eq!(saved(&file, &key).diff[0].rect, first.moved([100., 40.]));
    drag(&mut v, "canvas-resize-next-review-approve", [80., 60.]);
    assert_eq!(
        layout(&view, &v).diff[0].rect,
        first.moved([100., 40.]).resized([80., 60.])
    );
    // A pointer can leave the entire canvas mid-resize; release still ends it.
    drag(
        &mut v,
        "canvas-resize-next-review-approve",
        [-1400., -1000.],
    );
    assert_eq!(layout(&view, &v).diff[0].rect.w, geometry::MIN_W);
    assert_eq!(layout(&view, &v).diff[0].rect.h, geometry::MIN_H);
    drag(&mut v, "canvas-resize-next-review-approve", [480., 360.]);
    click(&mut v, "canvas-add-diff");
    pump(&mut v, |v| {
        v.debug_bounds("canvas-packet-next-review-reject").is_some()
    });
    click(&mut v, "canvas-packet-next-review-reject");
    // The first card's exposed right side raises on body press, without moving.
    let b = v.debug_bounds("canvas-card-next-review-approve").unwrap();
    v.simulate_click(
        point(b.right() - px(30.), b.top() + px(160.)),
        Modifiers::default(),
    );
    draw(&mut v);
    assert_eq!(
        layout(&view, &v).diff.last().unwrap().lane_id,
        "next-review-approve"
    );
    assert_eq!(layout(&view, &v).diff.len(), 2);
    v.simulate_keystrokes("s");
    draw(&mut v);
    view.read_with(&v, |p, cx| {
        assert!(
            p.diffs["next-review-approve"].read(cx).split,
            "the raised card receives the existing diff keyboard controls"
        );
        assert!(!p.diffs["next-review-reject"].read(cx).split);
    });
    let stage = v.debug_bounds("canvas-surface").unwrap();
    drag_from(
        &mut v,
        stage.bottom_right() - point(px(40.), px(40.)),
        [-80., -50.],
    );
    let card = v.debug_bounds("canvas-card-next-review-approve").unwrap();
    let camera = layout(&view, &v).camera;
    assert_eq!(
        ScrollDelta::from_magnification(0.25).pixel_delta(px(20.)),
        point(px(0.), px(0.)),
        "pinch never becomes scrolling in other native views"
    );
    v.simulate_event(ScrollWheelEvent {
        position: card.center(),
        delta: ScrollDelta::from_magnification(0.25),
        modifiers: Modifiers::default(),
        touch_phase: TouchPhase::Moved,
    });
    draw(&mut v);
    assert!(
        (layout(&view, &v).camera.zoom - camera.zoom * 1.25).abs() < 0.01,
        "pinch input zooms even over the diff body"
    );
    let before = layout(&view, &v);
    assert_ne!(before.camera, geometry::Camera::default());
    assert_ne!(saved(&file, &key).camera, before.camera, "pinch saves once it pauses");
    settle_saves(&mut v);
    assert_eq!(
        saved(&file, &key),
        before,
        "writer persisted geometry and stacking order"
    );
    // Close the real window, then reopen from disk, without any in-memory canvas entity.
    v.update(|w, _| w.remove_window());
    drop(view);
    drop(s);
    drop(v);
    let (_s, mut v, view) = open_canvas(&f, cx, file.clone(), State::load(&file).unwrap());
    assert_eq!(layout(&view, &v), before);
    click(&mut v, "canvas-fit-all");
    click(&mut v, "canvas-close-next-review-approve");
    assert_eq!(layout(&view, &v).diff.len(), 1);
    assert_eq!(layout(&view, &v).diff[0].lane_id, "next-review-reject");
    assert_eq!(
        State::load(&file).unwrap().canvas_layouts[&key],
        layout(&view, &v)
    );
}

#[gpui::test]
fn canvas_pan_pointer_zoom_reset_and_fit_use_input(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--onboarding --review");
    enable(&f, true);
    let (s, mut v, view) = open_canvas(&f, cx, f.root.join("pan.json"), State::default());
    drag(&mut v, "canvas-background", [80., -45.]);
    assert_eq!(layout(&view, &v).camera.pan, [80., -45.]);
    let b = v.debug_bounds("canvas-surface").unwrap();
    let pointer = b.center();
    let local = [
        f32::from(pointer.x - b.origin.x),
        f32::from(pointer.y - b.origin.y),
    ];
    let anchor = layout(&view, &v).camera.to_canvas(local);
    v.simulate_event(ScrollWheelEvent {
        position: pointer,
        delta: ScrollDelta::Pixels(point(px(0.), px(-50.))),
        modifiers: Modifiers {
            control: true,
            ..Default::default()
        },
        touch_phase: TouchPhase::Moved,
    });
    draw(&mut v);
    let camera = layout(&view, &v).camera;
    assert!(camera.zoom < 1.);
    let actual = camera.to_window(anchor);
    assert!((actual[0] - local[0]).abs() < 0.01 && (actual[1] - local[1]).abs() < 0.01);
    v.simulate_event(ScrollWheelEvent {
        position: pointer,
        delta: ScrollDelta::Pixels(point(px(12.), px(25.))),
        modifiers: Modifiers::default(),
        touch_phase: TouchPhase::Moved,
    });
    draw(&mut v);
    assert_eq!(
        layout(&view, &v).camera.pan,
        [camera.pan[0] + 12., camera.pan[1] + 25.]
    );
    v.simulate_keystrokes("ctrl-shift-p");
    v.simulate_input("Canvas: Reset zoom");
    assert!(
        s.read_with(&v, |s, _| s
            .commands()
            .iter()
            .any(|c| c.label(&s.sessions) == "Canvas: Reset zoom")),
        "reset is reachable from the global command palette"
    );
    v.simulate_keystrokes("enter");
    draw(&mut v);
    assert_eq!(layout(&view, &v).camera.zoom, 1.);
    click(&mut v, "canvas-add-diff");
    pump(&mut v, |v| {
        v.debug_bounds("canvas-packet-next-review-approve")
            .is_some()
    });
    click(&mut v, "canvas-packet-next-review-approve");
    // Zoomed drag uses canvas deltas, not screen deltas.
    v.simulate_event(ScrollWheelEvent {
        position: pointer,
        delta: ScrollDelta::Pixels(point(px(0.), px(-69.31472))),
        modifiers: Modifiers {
            control: true,
            ..Default::default()
        },
        touch_phase: TouchPhase::Moved,
    });
    draw(&mut v);
    let before = layout(&view, &v).diff[0].rect;
    click(&mut v, "canvas-fit-all");
    let r = v.debug_bounds("canvas-card-next-review-approve").unwrap();
    let stage = v.debug_bounds("canvas-surface").unwrap();
    assert!(stage.contains(&r.origin) && stage.contains(&r.bottom_right()));
    let zoom = layout(&view, &v).camera.zoom;
    drag(&mut v, "canvas-header-next-review-approve", [40., 20.]);
    let after = layout(&view, &v).diff[0].rect;
    assert!((after.x - before.x - 40. / zoom).abs() < 0.02);
    assert!((after.y - before.y - 20. / zoom).abs() < 0.02);
}

#[gpui::test]
fn canvas_setting_off_removes_commands_surface_and_restored_entry(cx: &mut TestAppContext) {
    let f = Fixture::start(true);
    enable(&f, false);
    let (s, mut v) = open_past_setup(
        f.client.clone(),
        f.root.join("off.json"),
        State::default(),
        cx,
    );
    ready(&s, &mut v);
    s.update_in(&mut v, |s, w, cx| s.execute(Command::Canvas, w, cx));
    draw(&mut v);
    assert!(v.debug_bounds("canvas-surface").is_none());
    assert!(s.read_with(&v, |s, _| {
        s.surface_commands().iter().all(|c| {
            !c.label(&s.sessions).contains("Canvas") && !c.label(&s.sessions).contains("canvas")
        })
    }));
    // A closed Canvas never polls the preference; the toggle applies its own change.
    enable(&f, true);
    let reads = s.read_with(&v, |s, _| s.surfaces.canvas.generation);
    s.update_in(&mut v, |s, w, cx| {
        s.surfaces.canvas.checked = Some(Instant::now() - Duration::from_secs(5));
        s.tick(false, w, cx);
    });
    v.run_until_parked();
    assert_eq!(s.read_with(&v, |s, _| s.surfaces.canvas.generation), reads);
    assert!(!s.read_with(&v, |s, _| enabled(s)));
    toggle(&s, &mut v, true);
    pump(&mut v, |v| s.read_with(v, |s, _| enabled(s)));
    s.update_in(&mut v, |s, w, cx| s.execute(Command::Canvas, w, cx));
    draw(&mut v);
    assert!(v.debug_bounds("canvas-surface").is_some());
    let saved_on = State::load(&f.root.join("off.json")).unwrap();
    enable(&f, false);
    pump(&mut v, |v| s.read_with(v, |s, _| !enabled(s)));
    assert!(v.debug_bounds("canvas-surface").is_none());
    assert!(s.read_with(&v, |s, _| {
        s.state
            .workspaces
            .values()
            .all(|w| !w.tabs.contains(&Tab::Canvas))
    }));
    assert!(s.read_with(&v, |s, _| {
        s.surface_commands()
            .iter()
            .all(|c| !c.label(&s.sessions).to_lowercase().contains("canvas"))
    }));
    v.update(|w, _| w.remove_window());
    drop(s);
    drop(v);
    let file = f.root.join("off.json");
    saved_on.save(&file).unwrap();
    let (s, mut v) = open_past_setup(
        f.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    ready(&s, &mut v);
    assert!(v.debug_bounds("canvas-surface").is_none());
    assert!(
        s.read_with(&v, |s, _| s
            .current()
            .is_some_and(|w| !w.tabs.contains(&Tab::Canvas))),
        "a saved Canvas tab is unavailable when the preference is off"
    );
}

#[gpui::test]
fn canvas_layout_follows_persisted_project_switches_for_a_shared_repository(
    cx: &mut TestAppContext,
) {
    let f = Fixture::start_mode(true, "--settings --shell --composer");
    enable(&f, true);
    let repo = f
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({"action":"add", "localPath":f.folders[0]}),
        )
        .unwrap();
    let mut ids = Vec::new();
    for name in ["Canvas first", "Canvas second"] {
        let project = f
            .client
            .project_request(
                "POST",
                "/api/projects",
                &json!({"name":name, "slug":name.to_lowercase().replace(' ', "-")}),
            )
            .unwrap();
        let id = project["project"]["id"].as_str().unwrap().to_owned();
        f.client
            .project_request(
                "POST",
                &format!("/api/projects/{id}/repos"),
                &json!({"repoId":repo["repo"]["id"]}),
            )
            .unwrap();
        ids.push(id);
    }
    let select = |id: &str| {
        f.client
            .project_request(
                "POST",
                "/api/panel/projects/active",
                &json!({"projectId":id}),
            )
            .unwrap();
    };
    select(&ids[0]);
    let file = f.root.join("projects.json");
    let (s, mut v, first) = open_canvas(&f, cx, file.clone(), State::default());
    drag(&mut v, "canvas-background", [42., 21.]);
    click(&mut v, "sidebar-project-switcher");
    let second_selector: &'static str =
        Box::leak(format!("sidebar-project-{}", ids[1]).into_boxed_str());
    pump(&mut v, |v| v.debug_bounds(second_selector).is_some());
    click(&mut v, second_selector);
    pump(&mut v, |v| {
        s.read_with(v, |s, _| active(s).is_some_and(|view| view != first))
    });
    let second = s.read_with(&v, |s, _| active(s)).unwrap();
    assert_ne!(first, second);
    assert_eq!(layout(&second, &v), model::Layout::default());
    drag(&mut v, "canvas-background", [-23., 71.]);
    let saved = State::load(&file).unwrap();
    assert_eq!(
        saved.canvas_layouts[&format!("project:{}", ids[0])]
            .camera
            .pan,
        [42., 21.]
    );
    assert_eq!(
        saved.canvas_layouts[&format!("project:{}", ids[1])]
            .camera
            .pan,
        [-23., 71.]
    );
    click(&mut v, "sidebar-project-switcher");
    let first_selector: &'static str =
        Box::leak(format!("sidebar-project-{}", ids[0]).into_boxed_str());
    pump(&mut v, |v| v.debug_bounds(first_selector).is_some());
    click(&mut v, first_selector);
    pump(&mut v, |v| {
        s.read_with(v, |s, _| active(s).is_some_and(|view| view == first))
    });
    assert_eq!(s.read_with(&v, |s, _| active(s)).unwrap(), first);
    assert_eq!(layout(&first, &v).camera.pan, [42., 21.]);
}

#[gpui::test]
fn canvas_loads_only_visible_diffs_and_shrinks_chrome(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--onboarding --review");
    enable(&f, true);
    let (_s, mut v, view) = open_canvas(&f, cx, f.root.join("many.json"), State::default());
    // The 32-card ceiling: four cards in a grid on the stage, the rest far to its right.
    let cards = (0..32)
        .map(|i| model::Card {
            lane_id: format!("lane-{i}"),
            title: format!("Lane {i}"),
            rect: geometry::Rect {
                x: if i < 4 { 330. * (i % 2) as f32 } else { 4000. },
                y: if i < 4 { 210. * (i / 2) as f32 } else { 0. },
                w: 320.,
                h: 200.,
            },
        })
        .collect::<Vec<_>>();
    view.update(&mut v, |p, cx| {
        p.layout.diff = cards;
        cx.notify();
    });
    draw(&mut v);
    view.read_with(&v, |p, _| {
        let mut loaded = p.diffs.keys().cloned().collect::<Vec<_>>();
        loaded.sort();
        assert_eq!(loaded, ["lane-0", "lane-1", "lane-2", "lane-3"]);
    });
    // Near 1% the header and resize corner stay inside the card.
    view.update(&mut v, |p, cx| {
        p.layout.camera = geometry::Camera {
            pan: [0., 0.],
            zoom: geometry::MIN_ZOOM,
        };
        cx.notify();
    });
    draw(&mut v);
    let card = v.debug_bounds("canvas-card-lane-0").unwrap();
    let header = v.debug_bounds("canvas-header-lane-0").unwrap();
    let corner = v.debug_bounds("canvas-resize-lane-0").unwrap();
    assert!(header.size.height <= card.size.height && corner.size.width <= card.size.width);
    assert!(v.debug_bounds("canvas-close-lane-0").is_none());
    // Zoomed out, every card reaches the stage and loads.
    assert_eq!(view.read_with(&v, |p, _| p.diffs.len()), 32);
}

#[gpui::test]
fn canvas_zoom_leaves_the_wheel_to_an_open_palette(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--onboarding --review");
    enable(&f, true);
    let (s, mut v, view) = open_canvas(&f, cx, f.root.join("palette.json"), State::default());
    v.simulate_keystrokes("ctrl-shift-p");
    draw(&mut v);
    assert!(s.read_with(&v, |s, _| s.palette));
    let stage = v.debug_bounds("canvas-surface").unwrap();
    v.simulate_event(ScrollWheelEvent {
        position: stage.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-50.))),
        modifiers: Modifiers {
            control: true,
            ..Default::default()
        },
        touch_phase: TouchPhase::Moved,
    });
    draw(&mut v);
    assert_eq!(layout(&view, &v).camera.zoom, 1., "the palette above keeps its wheel");
}

#[test]
fn a_malformed_saved_card_is_dropped_without_resetting_shell_state() {
    let file = std::env::temp_dir().join(format!("o8-canvas-bad-card-{}.json", std::process::id()));
    let mut state = State::default();
    state.tab_labels.insert("tab".into(), "Kept".into());
    state.canvas_layouts.insert(
        "workspace:a".into(),
        model::Layout {
            diff: vec![model::Card {
                lane_id: "good".into(),
                title: "Good".into(),
                rect: geometry::Rect {
                    x: 0.,
                    y: 0.,
                    w: 320.,
                    h: 200.,
                },
            }],
            ..Default::default()
        },
    );
    let mut value = serde_json::to_value(&state).unwrap();
    value["canvas_layouts"]["workspace:a"]["diff"]
        .as_array_mut()
        .unwrap()
        .push(json!({"laneId": 7, "x": "left"}));
    value["canvas_layouts"]["workspace:b"] = json!({"camera": "far"});
    std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    let loaded = State::load(&file).unwrap();
    std::fs::remove_file(&file).ok();
    assert_eq!(loaded.tab_labels["tab"], "Kept", "the rest of the shell state survives");
    assert_eq!(loaded.canvas_layouts.len(), 1);
    let cards = &loaded.canvas_layouts["workspace:a"].diff;
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].lane_id, "good");
}
