//! "Open in editor": open a project folder in the editor the operator chose
//! (`[editor] command`, default `code`). A project on another saved machine
//! opens over SSH with `code --remote ssh-remote+<host> <path>`, using the host
//! the machine registry stores. Ported from the desktop's `/api/panel/open-in`.
use crate::client::Client;
use crate::shell::settings::machines::SSH_MACHINES;
use serde_json::Value;
use std::process::{Command, Stdio};

const DEFAULT_EDITOR: &str = "code";
const DEFAULTS: &str = "/api/panel/operator-defaults";

/// Where the project folder lives.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Place<'a> {
    /// This computer.
    Here,
    /// A saved machine, with the SSH host its registry entry stores, if any.
    Remote(Option<&'a str>),
}

/// The programs to try, in order, each as a full argv. No shell is involved,
/// and only an absolute path is accepted, so a stored path cannot read as an
/// option. On macOS a local `code` that is not on PATH falls back to the app.
pub(crate) fn argv(
    editor: &str,
    place: Place,
    path: &str,
    macos: bool,
) -> Result<Vec<Vec<String>>, String> {
    let editor = match editor.trim() {
        "" => DEFAULT_EDITOR,
        editor => editor,
    };
    if editor.starts_with('-') || editor.contains(char::is_whitespace) {
        return Err("The editor command must be a single program name.".into());
    }
    if !path.starts_with('/') {
        return Err("Only an absolute project folder can be opened.".into());
    }
    match place {
        Place::Here => {
            let mut tries = vec![vec![editor.to_owned(), path.to_owned()]];
            if macos && editor == DEFAULT_EDITOR {
                tries.push(
                    ["open", "-a", "Visual Studio Code", path]
                        .map(str::to_owned)
                        .to_vec(),
                );
            }
            Ok(tries)
        }
        Place::Remote(host) => {
            let host = host
                .map(str::trim)
                .filter(|host| !host.is_empty() && !host.starts_with('-'))
                .ok_or("This project's machine has no saved SSH host.")?;
            Ok(vec![vec![
                editor.to_owned(),
                "--remote".to_owned(),
                format!("ssh-remote+{host}"),
                path.to_owned(),
            ]])
        }
    }
}

/// Runs each argv until one starts and exits cleanly.
pub(crate) fn launch(tries: &[Vec<String>]) -> Result<(), String> {
    let opened = tries.iter().any(|argv| {
        let Some((program, args)) = argv.split_first() else {
            return false;
        };
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    });
    if opened {
        return Ok(());
    }
    let program = tries.first().and_then(|argv| argv.first());
    Err(format!(
        "Could not open the editor. Install the `{}` command, or set Editor command in Settings.",
        program.map_or(DEFAULT_EDITOR, String::as_str)
    ))
}

/// The SSH host a saved machine's registry entry stores.
fn host(client: &Client, machine: &str) -> Option<String> {
    let saved = client.get::<Value>(SSH_MACHINES, &[]).ok()?;
    saved["machines"]
        .as_array()?
        .iter()
        .find(|entry| entry["id"] == machine)?["target"]
        .as_str()
        .map(str::to_owned)
}

/// Opens `path` in the saved editor: here, or on `machine` over SSH. Blocking;
/// run it off the UI thread.
pub(crate) fn open(client: &Client, machine: Option<&str>, path: &str) -> Result<(), String> {
    let editor = client
        .get::<Value>(DEFAULTS, &[("include", "values")])
        .ok()
        .and_then(|defaults| {
            defaults["values"]["editorCommand"]
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let host = machine.and_then(|machine| host(client, machine));
    let place = match machine {
        None => Place::Here,
        Some(_) => Place::Remote(host.as_deref()),
    };
    launch(&argv(&editor, place, path, cfg!(target_os = "macos"))?)
}

/// A fake `code` first on PATH that records each argv, one argument per line.
#[cfg(test)]
pub(crate) mod fake_code {
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

    static LOCK: Mutex<()> = Mutex::new(());
    static BIN: OnceLock<PathBuf> = OnceLock::new();

    /// Holds the fake for one test; the returned file is emptied first.
    pub(crate) fn install() -> (MutexGuard<'static, ()>, PathBuf) {
        let guard = LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let bin = BIN.get_or_init(|| {
            use std::os::unix::fs::PermissionsExt;
            let bin = crate::shell::test_support::scratch_path("o8-fake-code");
            std::fs::create_dir_all(&bin).unwrap();
            let script = bin.join("code");
            std::fs::write(
                &script,
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$(dirname \"$0\")/argv.log\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut dirs = vec![bin.clone()];
            dirs.extend(std::env::split_paths(&path));
            // SAFETY: set once per test process, before any test spawns `code`.
            // It only prepends a directory, so other tests' programs still resolve.
            unsafe { std::env::set_var("PATH", std::env::join_paths(dirs).unwrap()) };
            bin
        });
        let log = bin.join("argv.log");
        std::fs::write(&log, "").unwrap();
        (guard, log)
    }

    /// Every recorded argument, in order.
    pub(crate) fn args(log: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    fn strings(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn a_local_project_opens_with_code_and_falls_back_to_the_app_on_macos() {
        let tries = argv("code", Place::Here, "/work/repo", true).unwrap();
        assert_eq!(
            tries,
            [
                strings(&["code", "/work/repo"]),
                strings(&["open", "-a", "Visual Studio Code", "/work/repo"]),
            ]
        );
        let tries = argv("", Place::Here, "/work/repo", false).unwrap();
        assert_eq!(
            tries,
            [strings(&["code", "/work/repo"])],
            "empty means code"
        );
        let tries = argv("cursor", Place::Here, "/work/repo", true).unwrap();
        assert_eq!(
            tries,
            [strings(&["cursor", "/work/repo"])],
            "the app fallback is VS Code's"
        );
    }

    #[test]
    fn a_remote_project_opens_over_ssh_with_the_saved_host() {
        let tries = argv("code", Place::Remote(Some("me@box")), "/home/me/repo", true).unwrap();
        assert_eq!(
            tries,
            [strings(&[
                "code",
                "--remote",
                "ssh-remote+me@box",
                "/home/me/repo"
            ])]
        );
    }

    #[test]
    fn a_remote_project_without_a_saved_host_is_refused() {
        for host in [None, Some(""), Some("  "), Some("-oProxyCommand=x")] {
            let error = argv("code", Place::Remote(host), "/home/me/repo", true).unwrap_err();
            assert_eq!(
                error, "This project's machine has no saved SSH host.",
                "{host:?}"
            );
        }
    }

    #[test]
    fn a_path_with_spaces_stays_one_argument() {
        let path = "/work/my project/repo two";
        assert_eq!(
            argv("code", Place::Here, path, false).unwrap(),
            [strings(&["code", path])]
        );
        assert_eq!(
            argv("code", Place::Remote(Some("box")), path, false).unwrap(),
            [strings(&["code", "--remote", "ssh-remote+box", path])]
        );
    }

    #[test]
    fn only_an_absolute_path_and_a_single_program_are_accepted() {
        assert!(argv("code", Place::Here, "--new-window", false).is_err());
        assert!(argv("code", Place::Here, "repo", false).is_err());
        assert!(argv("--help", Place::Here, "/repo", false).is_err());
        assert!(argv("code --wait", Place::Here, "/repo", false).is_err());
    }

    /// Answers the two reads `open` makes, with the given editor and machines.
    fn server(editor: Option<&str>, machines: Value) -> Client {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let defaults = serde_json::json!({"values": {"editorCommand": editor}});
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                let body = if first.contains(SSH_MACHINES) {
                    machines.to_string()
                } else {
                    defaults.to_string()
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Client::authenticated(&origin, None).unwrap()
    }

    #[test]
    fn the_action_runs_code_from_path_here_and_over_ssh() {
        let (_guard, log) = fake_code::install();
        let machines = serde_json::json!({"machines": [
            {"id": "box", "label": "Box", "target": "me@box", "port": 22},
            {"id": "bare", "label": "Bare", "port": 22}
        ]});
        let client = server(Some("code"), machines);

        open(&client, None, "/work/my repo").unwrap();
        assert_eq!(fake_code::args(&log), ["/work/my repo"]);

        std::fs::write(&log, "").unwrap();
        open(&client, Some("box"), "/home/me/repo").unwrap();
        assert_eq!(
            fake_code::args(&log),
            ["--remote", "ssh-remote+me@box", "/home/me/repo"]
        );

        std::fs::write(&log, "").unwrap();
        let error = open(&client, Some("bare"), "/home/me/repo").unwrap_err();
        assert_eq!(error, "This project's machine has no saved SSH host.");
        assert!(
            fake_code::args(&log).is_empty(),
            "nothing runs without a host"
        );
    }

    #[test]
    fn an_editor_that_is_not_installed_reports_an_error() {
        let (_guard, log) = fake_code::install();
        let client = server(
            Some("o8-no-such-editor"),
            serde_json::json!({"machines": []}),
        );
        let error = open(&client, None, "/work/repo").unwrap_err();
        assert!(error.contains("`o8-no-such-editor`"), "{error}");
        assert!(fake_code::args(&log).is_empty());
    }
}
