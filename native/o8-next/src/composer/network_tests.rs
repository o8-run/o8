use super::*;
#[path = "network_recovery_tests.rs"]
mod recovery;
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Stdio},
};

struct Fixture {
    server: Child,
    client: Client,
}
impl Fixture {
    fn start() -> Self {
        let mut server = std::process::Command::new("node")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "native/o8-next/src/composer/fixtures/network-thread.ts",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
        let origin = lines
            .find_map(|line| {
                serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("production network fixture origin");
        std::thread::spawn(move || for _ in lines {});
        Self {
            server,
            client: Client::authenticated(&origin, Some("native-network-fixture".into())).unwrap(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
fn settle(surface: &Entity<Surface>, cx: &mut VisualTestContext) {
    for _ in 0..120 {
        cx.run_until_parked();
        draw(cx);
        if surface.read_with(cx, |s, _| s.queue_ready && !s.history_loading && !s.saving) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("native network pane did not finish loading");
}
fn open<'a>(
    cx: &'a mut TestAppContext,
    fixture: &Fixture,
) -> (Entity<Surface>, &'a mut VisualTestContext) {
    let client = fixture.client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = fixture.client.sessions().unwrap();
        s.select("thoughts-network-native".into(), cx);
    });
    settle(&surface, cx);
    (surface, cx)
}

#[gpui::test]
fn bot_network_native_history_retains_peer_author(cx: &mut TestAppContext) {
    let fixture = Fixture::start();
    let (surface, cx) = open(cx, &fixture);
    let rows = surface.read_with(cx, |s, _| {
        s.rows
            .iter()
            .map(|r| serde_json::to_value(&r.borrow().row).unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(rows[1]["author"]["name"], "OriginalPeer");
    assert_eq!(rows[1]["author"]["kind"], "bot");
    assert_eq!(rows[1]["role"], "assistant");
    let routing = surface.read_with(cx, |s, cx| s.composer_routing(cx).unwrap());
    assert_eq!(routing["source"], "bot-network");
    assert!(routing["backend"].is_null());
    assert!(surface.read_with(cx, |s, cx| s.voice_binding(cx).is_none()));
    assert!(cx.debug_bounds("network-composer-footer").is_some());
}

#[gpui::test]
fn bot_network_native_composer_uses_production_bus_route(cx: &mut TestAppContext) {
    let fixture = Fixture::start();
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, cx| {
        s.composer
            .update(cx, |i, cx| i.set_text("From the native composer", cx));
        s.send(None, cx);
    });
    settle(&surface, cx);
    let receipt: Value = fixture.client.get("/fixture/state", &[]).unwrap();
    let messages = receipt["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3, "native send must be accepted by the bus");
    assert_eq!(messages[2]["text"], "From the native composer");
    assert_eq!(messages[2]["conversation"]["replyToId"], messages[1]["id"]);
    assert_eq!(
        messages[2]["conversation"]["id"],
        messages[0]["conversation"]["id"]
    );
    assert_eq!(receipt["queue"], json!([]));
    assert_eq!(receipt["unexpectedDispatches"], 0);
}

#[gpui::test]
fn bot_network_native_refusal_keeps_the_draft_and_allows_a_fresh_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::start();
    let (surface, cx) = open(cx, &fixture);
    let _: Value = fixture.client.get("/fixture/disconnect", &[]).unwrap();
    surface.update(cx, |s, cx| {
        s.composer
            .update(cx, |i, cx| i.set_text("Retained after refusal", cx));
        s.send(None, cx);
    });
    settle(&surface, cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "Retained after refusal");
        assert!(s.pending.is_empty());
    });
    let _: Value = fixture.client.get("/fixture/reconnect", &[]).unwrap();
    surface.update(cx, |s, cx| s.send(None, cx));
    settle(&surface, cx);
    let receipt: Value = fixture.client.get("/fixture/state", &[]).unwrap();
    assert_eq!(receipt["messages"].as_array().unwrap().len(), 3);
    assert_eq!(receipt["messages"][2]["text"], "Retained after refusal");
    assert_eq!(receipt["queue"], json!([]));
}

#[gpui::test]
fn bot_network_native_composer_retries_a_held_send_with_its_saved_identity(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start();
    let _: Value = fixture.client.get("/fixture/held", &[]).unwrap();
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, cx| {
        s.composer
            .update(cx, |i, cx| i.set_text("Keep this separate draft", cx))
    });
    draw(cx);
    let retry = cx
        .debug_bounds("retry-network-send")
        .expect("the held network send has a native Retry control");
    cx.simulate_click(retry.center(), Modifiers::default());
    settle(&surface, cx);
    let receipt: Value = fixture.client.get("/fixture/state", &[]).unwrap();
    assert_eq!(receipt["messages"].as_array().unwrap().len(), 3);
    assert_eq!(receipt["messages"][2]["text"], "Recovered held send");
    assert_eq!(receipt["queue"], json!([]));
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "Keep this separate draft"
    );
}
