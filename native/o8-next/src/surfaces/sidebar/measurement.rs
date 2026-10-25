//! Headless 2,000-thread first-paint and scroll workload.
use super::*;
#[gpui::test]
fn sidebar_2000_thread_first_paint_and_scroll_measurement(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    let mut first_paint = vec![];
    let mut scroll = vec![];
    let mut max_visible = 0;
    for sample in 0..10 {
        let start = Instant::now();
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join(format!("measure-{sample}.json")),
            State::default(),
            cx,
        );
        let cx = &mut visual;
        loop {
            cx.run_until_parked();
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
            });
            if shell.read_with(cx, |s, cx| {
                s.connected
                    && s.surfaces
                        .sidebar
                        .view
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .painted
                        .get()
                        != usize::MAX
            }) {
                break;
            }
            assert!(
                start.elapsed() < std::time::Duration::from_secs(20),
                "HTTP bootstrap must reach a painted thread"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        first_paint.push(start.elapsed().as_secs_f64() * 1000.);
        shell.read_with(cx, |s, cx| {
            let sidebar = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
            assert_eq!(
                sidebar
                    .sessions
                    .iter()
                    .filter(|s| s.id.starts_with("thoughts-sidebar-"))
                    .count(),
                2000
            );
            assert_ne!(
                sidebar.painted.get(),
                usize::MAX,
                "sidebar row reached CPU scene paint"
            );
        });
        // Reveal the full inventory through keyboard input before the 2,000-row scroll workload.
        cx.simulate_keystrokes("f8 end home");
        draw(cx);
        let bounds = cx.debug_bounds("thread-list").unwrap();
        let initial_painted = shell.read_with(cx, |s, cx| {
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .painted
                .get()
        });
        for i in 0..50 {
            shell.read_with(cx, |s, cx| {
                s.surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .painted
                    .set(usize::MAX)
            });
            let start = Instant::now();
            cx.simulate_event(ScrollWheelEvent {
                position: bounds.center(),
                delta: ScrollDelta::Pixels(point(px(0.), px(if i < 25 { -144. } else { 144. }))),
                ..Default::default()
            });
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
            });
            scroll.push(start.elapsed().as_secs_f64() * 1000.);
            max_visible = max_visible.max(shell.read_with(cx, |s, cx| {
                s.surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .materialized
                    .get()
            }));
            shell.read_with(cx, |s, cx| {
                assert_ne!(
                    s.surfaces
                        .sidebar
                        .view
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .painted
                        .get(),
                    usize::MAX,
                    "scroll frame reached row paint"
                )
            });
            if i == 24 {
                shell.read_with(cx, |s, cx| {
                    let list = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
                    assert!(
                        list.painted.get() > initial_painted + 50,
                        "wheel must paint later virtual rows"
                    );
                });
            }
        }
        // First/last navigation also crosses the complete virtual inventory.
        shell.read_with(cx, |s, cx| {
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .scroll
                .scroll_to_item(
                    s.surfaces
                        .sidebar
                        .view
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .rows
                        .len()
                        - 1,
                    ScrollStrategy::Top,
                )
        });
        draw(cx);
        shell.read_with(cx, |s, cx| {
            assert!(
                s.surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .painted
                    .get()
                    > 1900
            )
        });
        assert!(cx.simulate_close());
    }
    let percentile = |samples: &[f64], p: f64| {
        let mut sorted = samples.to_vec();
        sorted.sort_by(f64::total_cmp);
        sorted[((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1)]
    };
    assert!(
        max_visible < 80,
        "only viewport rows should be materialized"
    );
    let receipt = json!({"threads":2000,"maxVisibleRows":max_visible,"endpoint":"GPUI TestAppContext CPU scene paint; test text system; no GPU/compositor", "firstPaintMs":first_paint,
        "scrollFrameMs":scroll,"firstPaintP50Ms":percentile(&first_paint,0.5),"firstPaintP95Ms":percentile(&first_paint,0.95),
        "scrollP50Ms":percentile(&scroll,0.5),"scrollP95Ms":percentile(&scroll,0.95)});
    if let Ok(file) = std::env::var("O8_NEXT_SIDEBAR_RESULTS") {
        fs::File::create(file)
            .unwrap()
            .write_all(serde_json::to_string_pretty(&receipt).unwrap().as_bytes())
            .unwrap();
    }
    println!("O8_NEXT_SIDEBAR_EVIDENCE {receipt}");
}
