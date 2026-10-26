//! The installed app owns the native window through a stdin pipe. Its EOF is
//! reliable on orderly shutdown and forced server death on both macOS and Linux.
use std::io::Read;

pub fn watch() {
    if std::env::var("O8_NEXT_PARENT_PIPE").as_deref() != Ok("1") {
        return;
    }
    std::thread::spawn(|| {
        let mut byte = [0_u8; 1];
        loop {
            match std::io::stdin().read(&mut byte) {
                Ok(0) | Err(_) => std::process::exit(0),
                Ok(_) => {}
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
