//! Owned production-route fixture and GPUI interaction helpers for Files tests.
use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

pub(super) struct Fixture {
    child: Child,
    pub(super) client: Client,
    pub(super) root: PathBuf,
    pub(super) repo: String,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-files-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut child = Command::new("node")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "native/o8-next/src/files_panel/fixture.ts",
            ])
            .env("O8_FILES_FIXTURE_ROOT", &root)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let info: Value = output
            .by_ref()
            .find_map(|line| serde_json::from_str(&line.ok()?).ok())
            .expect("owned fixture origin");
        // Route dependencies can log after startup. Retain and drain the pipe
        // until the owned server exits, rather than closing its stdout early.
        std::thread::spawn(move || for _ in output {});
        Self {
            child,
            client: Client::authenticated(info["origin"].as_str().unwrap(), None).unwrap(),
            repo: info["repo"].as_str().unwrap().into(),
            root,
        }
    }
    pub(super) fn requests(&self) -> Vec<String> {
        match fs::read_to_string(self.root.join("requests.json")) {
            Ok(log) => serde_json::from_str(&log).unwrap(),
            // Native results may arrive before the first HTTP request.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(error) => panic!("fixture request log: {error}"),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
pub(super) fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
pub(super) fn wait(cx: &mut VisualTestContext, selector: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        draw(cx);
        if cx.debug_bounds(selector).is_some() {
            return;
        }
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("missing native Files control {selector}");
}
pub(super) fn wait_requests(
    cx: &mut VisualTestContext,
    fixture: &Fixture,
    ready: impl Fn(&[String]) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        draw(cx);
        if ready(&fixture.requests()) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "missing expected Files HTTP request"
        );
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(super) fn click(cx: &mut VisualTestContext, selector: &'static str) {
    wait(cx, selector);
    let target = cx.debug_bounds(selector).unwrap().center();
    cx.simulate_click(target, gpui::Modifiers::default());
    draw(cx);
}
pub(super) fn search(cx: &mut VisualTestContext, selector: &'static str, text: &str) {
    click(cx, selector);
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a backspace"
    } else {
        "ctrl-a backspace"
    });
    cx.simulate_input(text);
    cx.run_until_parked();
    cx.cx.executor().advance_clock(Duration::from_millis(150));
    draw(cx);
}

pub(super) fn test_panel<'a>(
    fixture: &Fixture,
    cx: &'a mut TestAppContext,
) -> (Entity<FilesPanel>, &'a mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let panel = FilesPanel::new(
            fixture.client.clone(),
            fixture.repo.clone(),
            Mode::Files,
            cx,
        );
        panel.focus(window);
        panel
    })
}
