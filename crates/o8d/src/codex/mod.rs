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
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    events: VecDeque<Value>,
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
            stdin: child.stdin.take().unwrap(),
            stdout: BufReader::new(child.stdout.take().unwrap()),
            child,
            next_id: 1,
            events: VecDeque::new(),
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
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await
    }
    async fn read(&mut self) -> io::Result<Value> {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        let count = (&mut self.stdout)
            .take((FRAME_LIMIT + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Codex closed stdout",
            ));
        }
        if count > FRAME_LIMIT || bytes.last() != Some(&b'\n') {
            return Err(io::Error::other("Codex frame exceeds limit"));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    /// Server requests, including approvals, remain events for the caller. They
    /// are never implicitly approved. No bounded channel may silently drop them.
    pub async fn request(&mut self, method: &str, params: Value) -> io::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let wire = JSONRPCRequest {
            id: RequestId::Integer(id),
            method: method.into(),
            params: Some(params),
            trace: None,
        };
        self.write(&serde_json::to_value(wire)?).await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let value = self.read().await?;
                if value.get("method").is_none() && value["id"] == id {
                    if let Some(error) = value.get("error") {
                        return Err(io::Error::other(error.to_string()));
                    }
                    return Ok(value["result"].clone());
                }
                if self.events.len() >= 4096 {
                    return Err(io::Error::other("Codex event backlog exceeds limit"));
                }
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
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            // Kill the group even if its leader exits first: tools can ignore TERM.
            tokio::time::sleep(Duration::from_millis(100)).await;
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
