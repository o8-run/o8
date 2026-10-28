use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Stdio},
};
struct Host(Child);
impl Drop for Host {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.id().to_string()])
            .status();
        let _ = self.0.wait();
    }
}
fn fixture() -> (Host, Client) {
    let mut child = Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/dev-server.ts",
            "--visualizations",
        ])
        .env("O8_NEXT_API_TOKEN", "visualization-fixture-token")
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
    (
        Host(child),
        Client::authenticated(&origin, Some("visualization-fixture-token".into())).unwrap(),
    )
}
#[gpui::test]
fn visualization_at_its_message_and_reference_height(cx: &mut gpui::TestAppContext) {
    let (_host, client) = fixture();
    let history = client.history("thoughts-visualization").unwrap();
    let rows = crate::model::render_tree(&history.transcript);
    let card = rows
        .iter()
        .find_map(|row| match row {
            Row::Message { id, nodes, .. } if id == "visual-3" => Some(nodes),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        card.last().unwrap().kind,
        "visualization",
        "the reference must follow its message prose"
    );
    assert_eq!(
        card.last().unwrap().data.as_ref().unwrap()["height"].as_f64(),
        Some(320.)
    );
    assert_eq!(card.first().unwrap().kind, "p");
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| s.load_sessions(cx));
    cx.run_until_parked();
    view.update(cx, |s, cx| s.select("thoughts-visualization".into(), cx));
    cx.run_until_parked();
    let index = view.read_with(cx, |s, _| {
        s.rows
            .iter()
            .position(|r| r.borrow().row.id() == "visual-3")
            .unwrap()
    });
    view.update(cx, |s, cx| {
        s.list.scroll_to(ListOffset {
            item_ix: index,
            offset_in_item: px(0.),
        });
        cx.notify();
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    #[cfg(target_os = "macos")]
    assert!(view.read_with(cx, |s, _| s.rows[index].borrow().rendered().0) >= px(320.));
    #[cfg(not(target_os = "macos"))]
    view.read_with(cx, |s, _| {
        let (_, lines) = s.rows[index].borrow().rendered();
        assert!(lines.iter().any(|line| line.contains("Weekly activity")));
        assert!(
            lines
                .iter()
                .any(|line| line.contains(crate::visualizations::protocol::UNAVAILABLE))
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains(crate::visualizations::protocol::RETRY))
        );
    });
}

#[gpui::test]
fn missing_visualization_shows_error_and_retries_from_transcript(cx: &mut gpui::TestAppContext) {
    let (_host, client) = fixture();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| s.load_sessions(cx));
    cx.run_until_parked();
    view.update(cx, |s, cx| s.select("thoughts-visualization".into(), cx));
    cx.run_until_parked();
    let index = view.read_with(cx, |s, _| {
        s.rows
            .iter()
            .position(|r| r.borrow().row.id() == "visual-7")
            .unwrap()
    });
    view.update(cx, |s, cx| {
        s.list.scroll_to(ListOffset {
            item_ix: index,
            offset_in_item: px(0.),
        });
        cx.notify();
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let card = view.read_with(cx, |s, _| {
        s.rows[index]
            .borrow()
            .cards
            .values()
            .next()
            .unwrap()
            .clone()
    });
    let started = Instant::now();
    while card.borrow().error.is_none() && started.elapsed().as_secs() < 8 {
        view.update(cx, |s, cx| {
            s.poll_stream(cx);
        });
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    view.update(cx, |s, cx| {
        s.poll_stream(cx);
        cx.notify();
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let expected = if cfg!(target_os = "macos") {
        "Visualization not found."
    } else {
        crate::visualizations::protocol::UNAVAILABLE
    };
    assert_eq!(card.borrow().error.as_deref(), Some(expected));
    let (_, lines) = view.read_with(cx, |s, _| s.rows[index].borrow().rendered());
    assert!(
        lines.iter().any(|line| line.contains(expected)),
        "{lines:?}"
    );
    assert!(
        lines
            .iter()
            .any(|line| line.contains("Retry visualization")),
        "{lines:?}"
    );
    let nonce = card.borrow().nonce.clone();
    let bounds = card.borrow().bounds.unwrap();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    assert_ne!(
        nonce,
        card.borrow().nonce,
        "the transcript retry must start a fresh sealed document load"
    );
}
