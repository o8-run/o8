//! Opens a saved SSH machine in its own window, so threads run on that machine.
//! One SSH tunnel carries the far server's two ports; this binary then attaches
//! to the local end. The tunnel lives exactly as long as the window.
use serde_json::Value;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const REMOTE_API_PORT: u16 = 47120;
const REMOTE_WS_PORT: u16 = 47125;
const TOKEN_COMMAND: &str = "cat ~/.o8/ws-token";
const TUNNEL_WAIT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Route {
    pub id: String,
    pub target: String,
    pub port: u16,
    pub ssh_config: Option<String>,
}

impl Route {
    pub(crate) fn parse(machine: &Value) -> Option<Self> {
        Some(Self {
            id: machine["id"].as_str()?.to_owned(),
            target: machine["target"].as_str()?.to_owned(),
            port: machine["port"].as_u64().and_then(|port| port.try_into().ok())?,
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

    fn token_args(&self) -> Vec<String> {
        let mut args = self.base_args();
        args.extend(["--".to_owned(), self.target.clone(), TOKEN_COMMAND.to_owned()]);
        args
    }

    fn tunnel_args(&self, api: u16, ws: u16) -> Vec<String> {
        let forward = |local: u16, remote: u16| format!("127.0.0.1:{local}:127.0.0.1:{remote}");
        let mut args = self.base_args();
        args.extend([
            "-N".to_owned(),
            "-o".to_owned(),
            "ExitOnForwardFailure=yes".to_owned(),
            "-o".to_owned(),
            "ServerAliveInterval=15".to_owned(),
            "-L".to_owned(),
            forward(api, REMOTE_API_PORT),
            "-L".to_owned(),
            forward(ws, REMOTE_WS_PORT),
            "--".to_owned(),
            self.target.clone(),
        ]);
        args
    }

    pub(crate) fn open(self) -> Result<(), String> {
        let reply = Command::new("ssh")
            .args(self.token_args())
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| "Could not start ssh.".to_owned())?;
        let token = String::from_utf8_lossy(&reply.stdout).trim().to_owned();
        if !reply.status.success() || token.is_empty() {
            return Err("o8 is not running on this machine, or ssh could not reach it.".into());
        }
        let (api, ws) = (free_port()?, free_port()?);
        let mut tunnel = Command::new("ssh")
            .args(self.tunnel_args(api, ws))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start ssh.".to_owned())?;
        if !wait_for_port(api) {
            let _ = tunnel.kill();
            let _ = tunnel.wait();
            return Err("The tunnel to this machine did not open.".into());
        }
        let home = std::env::var("HOME").map_err(|_| "HOME is not set.".to_owned())?;
        let binary = std::env::current_exe().map_err(|_| "Could not find this app.".to_owned())?;
        let window = Command::new(binary)
            .args([
                "--enable-next",
                "--app-shell",
                "--server",
                &format!("http://127.0.0.1:{api}"),
                "--shell-state",
                &format!("{home}/.o8/next-shell-{}.json", self.id),
            ])
            .env("O8_NEXT_API_TOKEN", token)
            .env("O8_NEXT_TUNNEL_HOST", format!("127.0.0.1:{REMOTE_API_PORT}"))
            .env("O8_NEXT_WS_PORT", ws.to_string())
            .env_remove("O8_NEXT_CLERK_SESSION_TOKEN")
            .env_remove("O8_NEXT_TOKEN_FILE")
            .env_remove("O8_NEXT_TOKEN_FILES")
            .env_remove("O8_NEXT_TOKEN_ORIGIN")
            .env_remove("O8_NEXT_PARENT_PIPE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut window = match window {
            Ok(window) => window,
            Err(_) => {
                let _ = tunnel.kill();
                let _ = tunnel.wait();
                return Err("Could not open a window for this machine.".into());
            }
        };
        std::thread::spawn(move || {
            let _ = window.wait();
            let _ = tunnel.kill();
            let _ = tunnel.wait();
        });
        Ok(())
    }
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
        let args = route().tunnel_args(5000, 5001);
        assert_eq!(&args[args.len() - 2..], ["--", "me@box"]);
        assert!(args.contains(&"127.0.0.1:5000:127.0.0.1:47120".to_owned()));
        assert!(args.contains(&"127.0.0.1:5001:127.0.0.1:47125".to_owned()));
        let token = route().token_args();
        assert_eq!(&token[token.len() - 3..], ["--", "me@box", TOKEN_COMMAND]);
    }

    #[test]
    fn a_record_without_a_port_cannot_be_opened() {
        assert_eq!(Route::parse(&json!({"id":"a","target":"me@box"})), None);
    }
}
