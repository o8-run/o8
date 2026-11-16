//! The installed app owns the native window through a stdin pipe. Its EOF is
//! reliable on orderly shutdown and forced server death on both macOS and Linux.
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::{BufRead, Write},
    sync::Mutex,
};

static REQUESTS: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());

pub(crate) fn take_browser_request() -> Option<Value> {
    REQUESTS.lock().unwrap().pop_front()
}
pub(crate) fn browser_result(id: &str, result: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(
        out,
        "o8-next-browser-result:{}",
        json!({"id":id,"result":result})
    );
    let _ = out.flush();
}

pub fn watch() {
    if std::env::var("O8_NEXT_PARENT_PIPE").as_deref() != Ok("1") {
        return;
    }
    watch_documents();
    std::thread::spawn(|| {
        let input = std::io::stdin();
        let mut input = input.lock();
        loop {
            // Parent-owned, newline-delimited controls. Bound even a malformed
            // frame; EOF retains the existing server-death lifecycle behavior.
            let mut line = Vec::new();
            loop {
                let available = match input.fill_buf() {
                    Ok([]) | Err(_) => std::process::exit(0),
                    Ok(bytes) => bytes,
                };
                let end = available.iter().position(|b| *b == b'\n');
                let count = end.map_or(available.len(), |at| at + 1);
                if line.len() + count > 1024 * 1024 {
                    std::process::exit(0);
                }
                line.extend_from_slice(&available[..count]);
                input.consume(count);
                if end.is_some() {
                    break;
                }
            }
            let Ok(frame) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if frame["type"] != "browser-agent" {
                continue;
            }
            let Some(id) = frame["id"].as_str().filter(|id| id.len() <= 128) else {
                continue;
            };
            let mut requests = REQUESTS.lock().unwrap();
            if requests.len() >= 32 {
                browser_result(
                    id,
                    json!({"ok":false,"error":"Browser action queue is full","actionDispatched":false}),
                );
            } else {
                requests.push_back(frame);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::watch;
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    #[test]
    fn parent_pipe_child() {
        if std::env::var("O8_NEXT_PARENT_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        watch();
        println!("parent-pipe-ready");
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn app_child_exits_when_parent_pipe_closes() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["parent_pipe_child", "--nocapture"])
            .env("O8_NEXT_PARENT_FIXTURE", "1")
            .env("O8_NEXT_PARENT_PIPE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        for line in BufReader::new(output).lines() {
            if line.unwrap().contains("parent-pipe-ready") {
                break;
            }
        }
        assert!(child.try_wait().unwrap().is_none());
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                panic!("native child retained a closed parent pipe");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(unix)]
static DOCUMENTS: Mutex<VecDeque<std::path::PathBuf>> = Mutex::new(VecDeque::new());
#[cfg(unix)]
pub(crate) fn take_document() -> Option<std::path::PathBuf> {
    DOCUMENTS.lock().unwrap().pop_front()
}
#[cfg(not(unix))]
fn watch_documents() {}
#[cfg(unix)]
fn watch_documents() {
    let Some(data) = document_directory() else {
        return;
    };
    std::thread::spawn(move || {
        loop {
            if DOCUMENTS.lock().unwrap().is_empty() {
                if let Ok(paths) = crate::document_transport::receive(&data) {
                    DOCUMENTS.lock().unwrap().extend(paths);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
}

/// The server passes an explicit state file even when ambient environment is
/// stripped. Its parent is the server-selected app data directory.
#[cfg(unix)]
pub(crate) fn document_directory() -> Option<std::path::PathBuf> {
    let args: Vec<_> = std::env::args_os().collect();
    args.windows(2)
        .find(|pair| pair[0] == "--shell-state")
        .and_then(|pair| {
            std::path::Path::new(&pair[1])
                .parent()
                .map(std::path::Path::to_path_buf)
        })
}
