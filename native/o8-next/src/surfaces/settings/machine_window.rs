//! Reaches a saved SSH machine: one SSH tunnel carries the far server's two
//! ports, and a `Link` owns that tunnel. Open attaches a window to the local end,
//! and the tunnel lives exactly as long as the window.
use crate::client::{Client, Tunnel};
use serde_json::Value;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// A source checkout writes no port files and always uses these two.
const DEFAULT_API_PORT: u16 = 47120;
const DEFAULT_WS_PORT: u16 = 47125;
/// Three lines: the token, then the ports an installed server chose.
// Only the token is required: a source checkout has no port files, and the
// last missing one must not fail the whole read.
const REMOTE_COMMAND: &str = "cat ~/.o8/ws-token || exit 1; echo; cat ~/.o8/api-port 2>/dev/null; \
     echo; cat ~/.o8/ws-port 2>/dev/null; true";
const TUNNEL_WAIT: Duration = Duration::from_secs(15);
/// The tunnel holds this open on a pipe from the app instead of running `-N`,
/// which never notices its parent. However the app ends, the pipe closes, this
/// reads end of input, and ssh exits with it.
const HOLD_COMMAND: &str = "cat > /dev/null";

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Route {
    pub id: String,
    pub target: String,
    pub port: u16,
    pub ssh_config: Option<String>,
}

#[derive(Debug, PartialEq)]
struct Remote {
    token: String,
    api: u16,
    ws: u16,
}

impl Remote {
    fn parse(output: &str) -> Option<Self> {
        let mut lines = output.lines().map(str::trim);
        let token = lines.next().filter(|token| !token.is_empty())?.to_owned();
        let mut port = |fallback: u16| {
            lines
                .next()
                .and_then(|line| line.parse().ok())
                .unwrap_or(fallback)
        };
        let api = port(DEFAULT_API_PORT);
        let ws = port(DEFAULT_WS_PORT);
        Some(Self { token, api, ws })
    }
}

/// A live tunnel to one machine. Dropping it closes the tunnel.
pub(crate) struct Link {
    api: u16,
    ws: u16,
    remote: Remote,
    tunnel: Child,
}

impl Link {
    /// A client for the far server, through this tunnel.
    pub(crate) fn client(&self) -> Result<Client, String> {
        Ok(Client::authenticated(
            &format!("http://127.0.0.1:{}", self.api),
            Some(self.remote.token.clone()),
        )?
        .with_tunnel(Some(Tunnel {
            host: format!("127.0.0.1:{}", self.remote.api),
            ws_port: Some(self.ws),
        })))
    }
    /// False once ssh has exited, which is how a dropped machine shows up.
    pub(crate) fn alive(&mut self) -> bool {
        matches!(self.tunnel.try_wait(), Ok(None))
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        let _ = self.tunnel.kill();
        let _ = self.tunnel.wait();
    }
}

impl Route {
    pub(crate) fn parse(machine: &Value) -> Option<Self> {
        Some(Self {
            id: machine["id"]
                .as_str()
                .filter(|id| usable_id(id))?
                .to_owned(),
            target: machine["target"].as_str()?.to_owned(),
            port: machine["port"]
                .as_u64()
                .and_then(|port| port.try_into().ok())?,
            ssh_config: machine["sshConfig"].as_str().map(str::to_owned),
        })
    }

    fn base_args(&self) -> Vec<String> {
        let mut args = vec![
            "-o".to_owned(),
            "BatchMode=yes".to_owned(),
            "-o".to_owned(),
            "ConnectTimeout=10".to_owned(),
            "-p".to_owned(),
            self.port.to_string(),
        ];
        if let Some(config) = &self.ssh_config {
            args.extend(["-F".to_owned(), config.clone()]);
        }
        args
    }

    fn remote_args(&self) -> Vec<String> {
        let mut args = self.base_args();
        args.extend([
            "--".to_owned(),
            self.target.clone(),
            REMOTE_COMMAND.to_owned(),
        ]);
        args
    }

    fn tunnel_args(&self, api: u16, ws: u16, remote: &Remote) -> Vec<String> {
        let forward = |local: u16, remote: u16| format!("127.0.0.1:{local}:127.0.0.1:{remote}");
        let mut args = self.base_args();
        args.extend([
            // A shared SSH connection would take these forwards and let this
            // process exit, so they'd outlive the tunnel that asked for them.
            "-o".to_owned(),
            "ControlMaster=no".to_owned(),
            "-o".to_owned(),
            "ControlPath=none".to_owned(),
            "-o".to_owned(),
            "ExitOnForwardFailure=yes".to_owned(),
            "-o".to_owned(),
            "ServerAliveInterval=15".to_owned(),
            "-L".to_owned(),
            forward(api, remote.api),
            "-L".to_owned(),
            forward(ws, remote.ws),
            "--".to_owned(),
            self.target.clone(),
            HOLD_COMMAND.to_owned(),
        ]);
        args
    }

    /// Reads the far server's token and ports, then opens the tunnel.
    pub(crate) fn connect(&self) -> Result<Link, String> {
        let reply = Command::new("ssh")
            .args(self.remote_args())
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| "Could not start ssh.".to_owned())?;
        let remote = reply
            .status
            .success()
            .then(|| Remote::parse(&String::from_utf8_lossy(&reply.stdout)))
            .flatten()
            .ok_or("o8 is not running on this machine, or ssh could not reach it.")?;
        let (api, ws) = (free_port()?, free_port()?);
        let mut tunnel = Command::new("ssh")
            .args(self.tunnel_args(api, ws, &remote))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start ssh.".to_owned())?;
        if !wait_for_port(api) {
            let _ = tunnel.kill();
            let _ = tunnel.wait();
            return Err("The tunnel to this machine did not open.".into());
        }
        Ok(Link {
            api,
            ws,
            remote,
            tunnel,
        })
    }

    pub(crate) fn open(self) -> Result<(), String> {
        let link = self.connect()?;
        let home = std::env::var("HOME").map_err(|_| "HOME is not set.".to_owned())?;
        let binary = std::env::current_exe().map_err(|_| "Could not find this app.".to_owned())?;
        let window = Command::new(binary)
            .args([
                "--enable-next",
                "--app-shell",
                "--server",
                &format!("http://127.0.0.1:{}", link.api),
                "--shell-state",
                &format!("{home}/.o8/next-shell-{}.json", self.id),
            ])
            .env("O8_NEXT_API_TOKEN", &link.remote.token)
            .env(
                "O8_NEXT_TUNNEL_HOST",
                format!("127.0.0.1:{}", link.remote.api),
            )
            .env("O8_NEXT_WS_PORT", link.ws.to_string())
            .env_remove("O8_NEXT_CLERK_SESSION_TOKEN")
            .env_remove("O8_NEXT_TOKEN_FILE")
            .env_remove("O8_NEXT_TOKEN_FILES")
            .env_remove("O8_NEXT_TOKEN_ORIGIN")
            .env_remove("O8_NEXT_PARENT_PIPE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut window = window.map_err(|_| "Could not open a window for this machine.")?;
        std::thread::spawn(move || {
            let _ = window.wait();
            drop(link);
        });
        Ok(())
    }
}

/// A machine id goes inside sidebar ids and workspace keys, so it can't hold
/// their separators. The server only saves UUIDs; this holds for any other.
fn usable_id(id: &str) -> bool {
    !id.is_empty() && !id.chars().any(|c| c == '~' || c == '|' || c.is_control())
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| "No local port is free.".to_owned())
}

fn wait_for_port(port: u16) -> bool {
    let started = Instant::now();
    while started.elapsed() < TUNNEL_WAIT {
        if TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn route() -> Route {
        Route::parse(&json!({"id":"a","target":"me@box","port":2222,"sshConfig":null})).unwrap()
    }

    #[test]
    fn the_target_always_follows_the_end_of_options() {
        let remote = Remote::parse("t\n47100\n47105\n").unwrap();
        let args = route().tunnel_args(5000, 5001, &remote);
        assert!(args.contains(&"ControlPath=none".to_owned()));
        assert_eq!(&args[args.len() - 3..], ["--", "me@box", HOLD_COMMAND]);
        assert!(!args.contains(&"-N".to_owned()), "-N outlives a killed app");
        assert!(args.contains(&"127.0.0.1:5000:127.0.0.1:47100".to_owned()));
        assert!(args.contains(&"127.0.0.1:5001:127.0.0.1:47105".to_owned()));
        let read = route().remote_args();
        assert_eq!(&read[read.len() - 3..], ["--", "me@box", REMOTE_COMMAND]);
    }

    #[test]
    fn the_hold_ends_when_its_pipe_closes() {
        let mut hold = Command::new("sh")
            .args(["-c", HOLD_COMMAND])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        drop(hold.stdin.take());
        assert!(hold.wait().unwrap().success());
    }

    #[test]
    fn the_remote_read_needs_the_token_and_not_the_port_files() {
        let home = std::env::temp_dir().join(format!("o8-remote-read-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".o8")).unwrap();
        let read = || {
            Command::new("sh")
                .args(["-c", REMOTE_COMMAND])
                .env("HOME", &home)
                .output()
                .unwrap()
        };
        assert!(!read().status.success(), "no token, no server");
        std::fs::write(home.join(".o8/ws-token"), "token\n").unwrap();
        let reply = read();
        std::fs::remove_dir_all(&home).unwrap();
        assert!(reply.status.success());
        assert!(Remote::parse(&String::from_utf8_lossy(&reply.stdout)).is_some());
    }

    #[test]
    fn a_server_without_port_files_uses_the_source_checkout_ports() {
        let remote = Remote::parse("token\n\n\n").unwrap();
        assert_eq!((remote.api, remote.ws), (47120, 47125));
        assert_eq!(Remote::parse("\n47100\n47105\n"), None);
        assert_eq!(Remote::parse(""), None);
    }

    #[test]
    fn an_id_that_would_break_a_sidebar_id_is_refused() {
        let with = |id: &str| json!({"id":id,"target":"me@box","port":22});
        assert!(Route::parse(&with("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")).is_some());
        for id in ["a~b", "a|b", "a\nb", ""] {
            assert_eq!(Route::parse(&with(id)), None, "{id:?}");
        }
    }

    #[test]
    fn a_record_without_a_port_cannot_be_opened() {
        assert_eq!(Route::parse(&json!({"id":"a","target":"me@box"})), None);
    }
}
