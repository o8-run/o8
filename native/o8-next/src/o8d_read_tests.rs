//! Saved-route compatibility only: full discovery still needs runtime inventory.
use super::*;
use gpui::TestAppContext;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};

struct Fixture {
    child: Child,
    directory: std::path::PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[gpui::test]
fn saved_history_surface_with_only_o8d(cx: &mut TestAppContext) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let directory = crate::shell::test_support::scratch_path("o8d-native-read");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("fixture-owner"), "o8d-native-read/v1").unwrap();
    let seeded = Command::new("node")
        .current_dir(&root)
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/seed-o8d.ts",
        ])
        .arg(&directory)
        .env("O8_NEXT_API_TOKEN", "fixture-native-read-credential")
        .output()
        .unwrap();
    assert!(
        seeded.status.success(),
        "owned persisted fixture seeding failed"
    );
    let binary = std::env::var_os("O8D_HTTP_TEST_BINARY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("crates/o8d/target/debug/o8d"));
    let mut child = Command::new(binary)
        .args([
            "--experimental-http",
            "--listen",
            "127.0.0.1:0",
            "--data-dir",
        ])
        .arg(&directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let line = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .next()
        .expect(
            "o8d exited before listening: build it with --features experimental-http \
             and set O8D_HTTP_TEST_BINARY to that binary",
        )
        .unwrap();
    let origin = format!(
        "http://{}",
        serde_json::from_str::<Value>(&line).unwrap()["listening"]
            .as_str()
            .unwrap()
    );
    let _fixture = Fixture { child, directory };
    let client =
        Client::authenticated(&origin, Some("fixture-native-read-credential".into())).unwrap();
    let saved: Value = client
        .get("/api/mobile/orchestrator/threads", &[("limit", "500")])
        .unwrap();
    let sessions: Vec<Session> = serde_json::from_value(saved["threads"].clone()).unwrap();
    assert_eq!(sessions.len(), 3);
    // Same Surface::select path as composer tests. No fixture API or Next listener exists.
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = sessions;
        s.select("thoughts-long".into(), cx);
    });
    cx.run_until_parked();
    surface.read_with(cx, |s, _| {
        assert_eq!(s.transcript.as_ref().unwrap().rows.len(), 100);
        assert!(s.queue_ready, "saved context and queue should load");
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
