use super::*;
use gpui::{Modifiers, TestAppContext};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Stdio},
};

struct Host(Child);
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[gpui::test]
fn native_image_history_route_paints_user_and_media_thumbnails(cx: &mut TestAppContext) {
    let mut host = Command::new("node")
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
    let mut lines = BufReader::new(host.stdout.take().unwrap()).lines();
    let origin = lines
        .find_map(|l| {
            serde_json::from_str::<Value>(&l.ok()?).ok()?["origin"]
                .as_str()
                .map(str::to_owned)
        })
        .expect("fixture origin");
    std::thread::spawn(move || for _ in lines {});
    let _host = Host(host);
    let client =
        Client::authenticated(&origin, Some("fixture-image-history-bearer".into())).unwrap();
    let reader = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = reader.sessions().unwrap();
        s.select("thoughts-image-fixture".into(), cx);
    });
    cx.run_until_parked();
    for _ in 0..2 {
        cx.update(|w, cx| {
            w.refresh();
            w.draw(cx).clear();
        });
    }
    for selector in [
        "transcript-image-user-image-0",
        "transcript-image-assistant-image-0",
    ] {
        let bounds = cx
            .debug_bounds(selector)
            .expect("history image must paint with bounds");
        assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
        assert!(bounds.size.height <= px(240.));
        assert!((f32::from(bounds.size.width / bounds.size.height) - 80. / 48.).abs() < 0.01);
    }
    let bounds = cx.debug_bounds("transcript-image-user-image-0").unwrap();
    let windows = cx.update(|_, cx| cx.windows().len());
    cx.simulate_click(bounds.center(), Modifiers::default());
    cx.run_until_parked();
    assert_eq!(
        cx.update(|_, cx| cx.windows().len()),
        windows + 1,
        "click opens the full-size viewer"
    );
    let viewer = cx.update(|_, cx| cx.windows().last().copied().unwrap());
    cx.cx
        .update_window(viewer, |_, w, cx| {
            w.dispatch_keystroke(gpui::Keystroke::parse("escape").unwrap(), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert_eq!(
        cx.update(|_, cx| cx.windows().len()),
        windows,
        "Escape closes the full-size viewer"
    );
    for selector in [
        "transcript-image-error-missing-image-0",
        "transcript-image-error-corrupt-image-0",
        "transcript-image-error-outside-image-0",
    ] {
        assert!(
            cx.debug_bounds(selector).is_some(),
            "short unavailable row: {selector}"
        );
    }
    let reads: Value = reader.get("/api/image-fixture", &[]).unwrap();
    assert_eq!(
        reads["reads"][reads["saved"].as_str().unwrap()],
        1,
        "shared image bytes are fetched once through the checked route"
    );
    assert_eq!(
        reads["reads"][reads["outside"].as_str().unwrap()],
        1,
        "outside paths reach the server path guard"
    );
}
