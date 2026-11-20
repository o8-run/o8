// Adapted from hardbeat920/monocode@09d04436b, crates/monocode-core/src/provider.rs
// and provider/lifecycle.rs. Codex-only stdio handshake and lifecycle.
// MIT License
//
// Copyright (c) 2026 Nick
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
use serde_json::{json, Value};
use std::{collections::VecDeque, io, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};
pub mod generated;
use generated::{JSONRPCRequest, RequestId};
const FRAME_LIMIT: usize = 16 * 1024 * 1024;

/// A warm app-server process. Completion does not close it; explicit cancellation
/// and Drop kill its private process group, including running tool descendants.
/// The caller supplies cwd, model, policy and isolated/real credentials explicitly.
pub struct Driver {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    frame: Vec<u8>,
    next_id: i64,
    events: VecDeque<Value>,
    event_bytes: usize,
}
impl Driver {
    pub async fn spawn(
        binary: impl AsRef<std::ffi::OsStr>,
        configure: impl FnOnce(&mut std::process::Command),
    ) -> io::Result<Self> {
        let mut command = crate::child_spawn::provider_command(binary);
        configure(&mut command);
        command.arg("app-server").arg("--stdio");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut command = tokio::process::Command::from(command);
        command.kill_on_drop(true);
        let mut child = command.spawn()?;
        Ok(Self {
            stdin: child.stdin.take(),
            stdout: BufReader::new(child.stdout.take().unwrap()),
            child,
            frame: Vec::new(),
            next_id: 1,
            events: VecDeque::new(),
            event_bytes: 0,
        })
    }
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }
    async fn write(&mut self, value: &Value) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        if bytes.len() > FRAME_LIMIT {
            return Err(io::Error::other("Codex frame exceeds limit"));
        }
        bytes.push(b'\n');
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "Codex input is closed"))?;
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    }
    async fn read(&mut self) -> io::Result<Value> {
        loop {
            let available = self.stdout.fill_buf().await?;
            if available.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Codex closed stdout",
                ));
            }
            let newline = available.iter().position(|b| *b == b'\n');
            let count = newline.map(|n| n + 1).unwrap_or(available.len());
            if self.frame.len() + count > FRAME_LIMIT {
                return Err(io::Error::other("Codex frame exceeds limit"));
            }
            self.frame.extend_from_slice(&available[..count]);
            self.stdout.consume(count);
            if newline.is_some() {
                let value = serde_json::from_slice(&self.frame);
                self.frame.clear();
                return Ok(value?);
            }
        }
    }
    /// Server requests, including approvals, remain events for the caller. They
    /// are never implicitly approved. No bounded channel may silently drop them.
    pub async fn start_request(&mut self, method: &str, params: Value) -> io::Result<i64> {
        let id = self.next_id;
        self.next_id += 1;
        let wire = JSONRPCRequest {
            id: RequestId::Integer(id),
            method: method.into(),
            params: Some(params),
            trace: None,
        };
        self.write(&serde_json::to_value(wire)?).await?;
        Ok(id)
    }
    pub async fn request(&mut self, method: &str, params: Value) -> io::Result<Value> {
        let id = self.start_request(method, params).await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let value = self.read().await?;
                if value.get("method").is_none() && value["id"] == id {
                    if let Some(error) = value.get("error") {
                        return Err(io::Error::other(error.to_string()));
                    }
                    return Ok(value["result"].clone());
                }
                let size = serde_json::to_vec(&value)?.len();
                if self.events.len() >= 4096 || self.event_bytes + size > FRAME_LIMIT {
                    return Err(io::Error::other("Codex event backlog exceeds limit"));
                }
                self.event_bytes += size;
                self.events.push_back(value);
            }
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Codex request outcome unknown"))?
    }
    pub async fn initialize(&mut self) -> io::Result<Value> {
        let result = self.request("initialize", json!({"clientInfo":{"name":"o8d","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        self.write(&json!({"method":"initialized"})).await?;
        Ok(result)
    }
    pub async fn next_event(&mut self) -> io::Result<Value> {
        if let Some(value) = self.events.pop_front() {
            self.event_bytes -= serde_json::to_vec(&value)?.len();
            return Ok(value);
        }
        self.read().await
    }
    pub async fn respond(&mut self, id: Value, result: Value) -> io::Result<()> {
        self.write(&json!({"id":id,"result":result})).await
    }
    pub async fn interrupt(&mut self, thread: &str, turn: &str) -> io::Result<Value> {
        self.request("turn/interrupt", json!({"threadId":thread,"turnId":turn}))
            .await
    }
    pub async fn cancel(&mut self) -> io::Result<()> {
        if let Some(pid) = self.child.id() {
            // EOF invokes Codex's connection teardown, which owns command
            // sessions in their own process groups. Killing only our group
            // cannot reach those tool groups.
            self.stdin.take();
            if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
                .await
                .is_err()
            {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            self.child.wait().await?;
        }
        Ok(())
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

/// The default-build `o8d codex` entry owns the CLI and its stdio lifecycle.
/// Protocol identities, approvals, model and effort are passed through unchanged.
pub async fn serve_stdio(arguments: &[String]) -> io::Result<()> {
    let binary = std::env::var_os("O8_CODEX_BINARY").unwrap_or_else(|| "codex".into());
    let mut driver = Driver::spawn(binary, |command| {
        command.args(arguments);
    })
    .await?;
    let (send, mut input) = tokio::sync::mpsc::channel(8);
    let input_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = BufReader::new(tokio::io::stdin());
        loop {
            let mut bytes = Vec::new();
            let answer = match (&mut reader)
                .take((FRAME_LIMIT + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .await
            {
                Ok(0) => break,
                Ok(_) if bytes.len() > FRAME_LIMIT => {
                    Err(io::Error::other("Codex frame exceeds limit"))
                }
                Ok(_) => serde_json::from_slice::<Value>(&bytes).map_err(io::Error::from),
                Err(error) => Err(error),
            };
            let failed = answer.is_err();
            if send.send(answer).await.is_err() || failed {
                break;
            }
        }
    });
    let mut output = tokio::io::stdout();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = terminate.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
            event = driver.next_event() => {
                match event {
                    Ok(value) => { let mut bytes=serde_json::to_vec(&value)?; bytes.push(b'\n'); output.write_all(&bytes).await?; output.flush().await?; },
                    Err(error) if error.kind()==io::ErrorKind::UnexpectedEof => break,
                    Err(error) => return Err(error),
                }
            },
            read = input.recv() => {
                let Some(value) = read else {break;};
                driver.write(&value?).await?;
            },
        }
    }
    input_task.abort();
    driver.cancel().await
}
