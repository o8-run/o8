//! Bounded labels only: never retain a request target, header or response body.
use std::{
    pin::Pin,
    task::{Context, Poll},
    time::Instant,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};

pub(super) struct Count {
    route: &'static str,
    method: &'static str,
    started: Instant,
}
impl Count {
    pub(super) fn new(header: &str) -> Self {
        let mut parts = header.lines().next().unwrap_or("").split_whitespace();
        let method = match parts.next().unwrap_or("") {
            "GET" => "GET",
            "POST" => "POST",
            "PUT" => "PUT",
            "PATCH" => "PATCH",
            "DELETE" => "DELETE",
            "HEAD" => "HEAD",
            "OPTIONS" => "OPTIONS",
            _ => "OTHER",
        };
        let path = parts.next().unwrap_or("").split('?').next().unwrap_or("");
        static ROUTES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
        let routes = ROUTES.get_or_init(|| {
            let mut routes: Vec<String> =
                serde_json::from_str(include_str!("../../route-templates.json"))
                    .expect("route templates");
            // Static paths win over dynamic siblings, then the longest prefix.
            routes
                .sort_by_key(|route| (route.matches('[').count(), std::cmp::Reverse(route.len())));
            routes
        });
        let route = routes
            .iter()
            .find(|route| matches_template(route, path))
            .map(String::as_str)
            .unwrap_or("__other__");
        Self {
            route,
            method,
            started: Instant::now(),
        }
    }
    pub(super) async fn finish(&self, status: Option<u16>) {
        let Some(path) = std::env::var_os("O8D_REQUEST_COUNTS_PATH") else {
            return;
        };
        let duration_bucket = match self.started.elapsed().as_millis() {
            0..=9 => "lt10ms",
            10..=99 => "lt100ms",
            100..=999 => "lt1s",
            _ => "gte1s",
        };
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "route": self.route, "method": self.method, "status": status,
            "durationBucket": duration_bucket,
        }))
        .expect("counts JSON");
        bytes.push(b'\n');
        // Acquire within the budget; once started, blocking I/O owns the guard
        // until completion even if the HTTP task stops waiting for the record.
        static LOCK: std::sync::OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
            std::sync::OnceLock::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(100);
        let lock = LOCK
            .get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        let Ok(guard) = tokio::time::timeout_at(deadline, lock.lock_owned()).await else {
            return;
        };
        let path = std::path::PathBuf::from(path);
        let writer = tokio::task::spawn_blocking(move || {
            let _guard = guard;
            if tokio::time::Instant::now() >= deadline {
                return;
            }
            let _ = append_record(&path, &bytes, 8 * 1024 * 1024);
        });
        let _ = tokio::time::timeout_at(deadline, writer).await;
    }
}

fn append_record(path: &std::path::Path, bytes: &[u8], limit: u64) -> std::io::Result<()> {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() >= limit) {
        std::fs::rename(path, path.with_extension("jsonl.1"))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let previous = file.metadata()?.len();
    // One syscall for the complete JSON line, including its newline. Never retry
    // a partial record: roll it back under the same serialization guard instead.
    match file.write(bytes) {
        Ok(written) if written == bytes.len() => Ok(()),
        result => {
            file.set_len(previous)?;
            match result {
                Err(error) => Err(error),
                _ => Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "short count record",
                )),
            }
        }
    }
}

fn matches_template(template: &str, path: &str) -> bool {
    let mut actual = path.split('/');
    for expected in template.split('/') {
        if expected.starts_with("[[...") {
            return true;
        }
        if expected.starts_with("[...") {
            return actual.next().is_some_and(|part| !part.is_empty());
        }
        let Some(part) = actual.next() else {
            return false;
        };
        if expected.starts_with('[') && expected.ends_with(']') {
            if part.is_empty() {
                return false;
            }
        } else if expected != part {
            return false;
        }
    }
    actual.next().is_none()
}

/// Observe only the bounded HTTP status line while preserving streaming uploads
/// and responses. Waiting for a response before forwarding a body would deadlock.
pub(super) struct Backend {
    pub(super) stream: TcpStream,
    line: Vec<u8>,
    done: bool,
    pub(super) status: Option<u16>,
}
impl Backend {
    pub(super) fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            line: Vec::new(),
            done: false,
            status: None,
        }
    }
}
impl AsyncRead for Backend {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let start = buf.filled().len();
        let result = Pin::new(&mut self.stream).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            for &byte in &buf.filled()[start..] {
                if self.done {
                    break;
                }
                if byte == b'\n' || self.line.len() == 64 {
                    self.status = std::str::from_utf8(&self.line).ok().and_then(|line| {
                        let mut parts = line.split_whitespace();
                        let version = parts.next()?;
                        if !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
                            return None;
                        }
                        parts
                            .next()?
                            .parse::<u16>()
                            .ok()
                            .filter(|code| (100..=599).contains(code))
                    });
                    self.done = self.status.is_some_and(|code| code == 101 || code >= 200);
                    if !self.done {
                        self.status = None;
                    }
                    self.line.clear();
                } else {
                    self.line.push(byte);
                }
            }
        }
        result
    }
}
impl AsyncWrite for Backend {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::TcpListener};

    #[test]
    fn rotates_complete_json_lines_and_replaces_the_previous_segment() {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("o8-count-rotation-{}-{id}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("counts.jsonl");
        let first = b"{\"status\":200}\n";
        let second = b"{\"status\":401}\n";
        let third = b"{\"status\":403}\n";
        append_record(&path, first, first.len() as u64).unwrap();
        append_record(&path, second, first.len() as u64).unwrap();
        assert_eq!(
            std::fs::read(path.with_extension("jsonl.1")).unwrap(),
            first
        );
        append_record(&path, third, second.len() as u64).unwrap();
        assert_eq!(
            std::fs::read(path.with_extension("jsonl.1")).unwrap(),
            second
        );
        assert_eq!(std::fs::read(&path).unwrap(), third);
        for segment in [&path, &path.with_extension("jsonl.1")] {
            let bytes = std::fs::read(segment).unwrap();
            assert_eq!(bytes.last(), Some(&b'\n'));
            for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
                serde_json::from_slice::<serde_json::Value>(line).unwrap();
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn uploads_stream_and_informational_status_is_not_recorded_as_final() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .await
                .unwrap();
            let mut body = [0; 4];
            socket.read_exact(&mut body).await.unwrap();
            assert_eq!(&body, b"body");
            socket
                .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                .await
                .unwrap();
        });
        let mut backend = Backend::new(TcpStream::connect(address).await.unwrap());
        backend.write_all(b"body").await.unwrap();
        let mut bytes = Vec::new();
        backend.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(backend.status, Some(204));
        peer.await.unwrap();
    }
}
