use super::*;
pub(super) use gpui::{TestAppContext, VisualTestContext};
pub(super) use serde_json::{Value, json};
pub(super) use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command as Process, Stdio},
    time::Instant,
};
pub(super) struct Fixture {
    pub(super) server: Child,
    pub(super) client: Client,
    pub(super) root: PathBuf,
    pub(super) folders: Vec<String>,
    pub(super) origin: String,
}
impl Fixture {
    pub(super) fn new() -> Self {
        Self::start_mode(false, "")
    }
    pub(super) fn brain() -> Self {
        Self::start_mode(false, "--brain")
    }
    pub(super) fn start(settings: bool) -> Self {
        Self::start_mode(false, if settings { "--settings" } else { "" })
    }
    pub(super) fn start_mode(projects: bool, option: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-shell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut command = Process::new("node");
        if projects {
            command
                .arg("--import")
                .arg("./scripts/register-server-only-stub.mjs")
                .arg("--import")
                .arg("tsx")
                .arg("scripts/next/dev-server.ts")
                .arg("--projects");
            if !option.is_empty() {
                command.args(option.split_whitespace());
            }
        } else {
            command.args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/dev-server.ts",
                "--composer",
                "--shell",
            ]);
        }
        if !projects {
            command.args(option.split_whitespace());
        }
        command.arg("--owned-stdio");
        let mut server = command
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .env(
                "O8_NEXT_BRAIN_REQUEST_LOG",
                root.join("brain-requests.json"),
            )
            .env("O8_NEXT_API_TOKEN", "fixture-shell-bearer")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(
                fs::File::create(root.join("fixture.log")).unwrap(),
            ))
            .spawn()
            .unwrap();
        let mut output = BufReader::new(server.stdout.take().unwrap()).lines();
        let receipt = output
            .by_ref()
            .find_map(|line| {
                let data = serde_json::from_str::<Value>(&line.ok()?).ok()?;
                data["origin"].as_str()?;
                Some(data)
            })
            .expect("fixture origin");
        // Production repository scans may log after the receipt. Keep stdout
        // drained so those writes cannot terminate the owned host with EPIPE.
        std::thread::spawn(move || for _ in output {});
        Self {
            server,
            client: Client::authenticated(
                receipt["origin"].as_str().unwrap(),
                Some("fixture-shell-bearer".into()),
            )
            .unwrap(),
            root,
            folders: receipt["folders"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect(),
            origin: receipt["origin"].as_str().unwrap().to_owned(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Process::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
        if let Ok(directory) = std::env::var("O8_NEXT_SETTINGS_DIAGNOSTICS") {
            let _ = fs::copy(
                self.root.join("fixture.log"),
                PathBuf::from(directory).join(format!("fixture-{}.log", self.server.id())),
            );
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
pub(super) fn open(
    client: Client,
    file: PathBuf,
    state: State,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext) {
    let handle = cx.update(|cx| view::open_window(client, file, state, true, cx));
    let shell = handle.root(cx).unwrap();
    let visual = VisualTestContext::from_window(handle.into(), cx);
    (shell, visual)
}
pub(super) fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
}
pub(super) fn ready(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..20 {
        cx.run_until_parked();
        draw(cx);
        if shell.read_with(cx, |s, cx| {
            s.active()
                .and_then(|t| s.content.get(&s.key(&t)))
                .is_some_and(|c| c.ready(cx))
        }) {
            return;
        }
    }
    panic!("selected fixture history must reach CPU scene paint through the existing surface");
}
