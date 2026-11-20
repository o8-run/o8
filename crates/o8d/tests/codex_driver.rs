#![cfg(all(unix, feature = "experimental-codex"))]
use o8d::codex::Driver;
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn real_codex_turn_events_warm_process_and_tree_cancellation() {
    // CI supplies the real CLI, never a fake driver binary. No account/network
    // inference is used: only the Responses model transport is a local fixture.
    let binary = std::env::var_os("O8_CODEX_TEST_BINARY")
        .expect("set O8_CODEX_TEST_BINARY to the real Codex CLI");
    let root = std::env::temp_dir().join(format!("o8-codex-driver-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut byte = [0; 1];
                while !buf.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut byte).await.is_err() {
                        return;
                    }
                    buf.push(byte[0]);
                    if buf.len() > 65536 {
                        return;
                    }
                }
                let header = String::from_utf8_lossy(&buf);
                let length = header
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                let output = json!({"id":"msg_fixture","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Fixture turn complete.","annotations":[]}]});
                let events = [
                    json!({"type":"response.created","response":{"id":"resp_fixture"}}),
                    json!({"type":"response.output_item.added","output_index":0,"item":{"id":"msg_fixture","type":"message","role":"assistant","content":[]}}),
                    json!({"type":"response.output_text.delta","item_id":"msg_fixture","output_index":0,"content_index":0,"delta":"Fixture turn complete."}),
                    json!({"type":"response.output_item.done","output_index":0,"item":output}),
                    json!({"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[output],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}),
                ];
                let body = events
                    .iter()
                    .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
                    .collect::<String>();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
        }
    });
    std::fs::write(root.join("config.toml"),format!("model = \"fixture\"\nmodel_provider = \"fixture\"\n[model_providers.fixture]\nname = \"Fixture\"\nbase_url = \"http://{address}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n")).unwrap();
    let mut driver = Driver::spawn(binary, |c| {
        c.current_dir(&root)
            .env("CODEX_HOME", &root)
            .env_remove("OPENAI_API_KEY")
            .env_remove("OPENAI_BASE_URL");
    })
    .await
    .unwrap();
    let pid = driver.pid().unwrap();
    driver.initialize().await.unwrap();
    let started=driver.request("thread/start",json!({"cwd":root,"approvalPolicy":"never","sandbox":"read-only","model":"fixture","ephemeral":true})).await.unwrap();
    let thread = started["thread"]["id"].as_str().unwrap();
    for _ in 0..2 {
        driver.request("turn/start",json!({"threadId":thread,"input":[{"type":"text","text":"Say the fixture answer.","text_elements":[]}]})).await.unwrap();
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let e = driver.next_event().await.unwrap();
                if e["method"] == "item/agentMessage/delta" {
                    text.push_str(e["params"]["delta"].as_str().unwrap());
                }
                if e["method"] == "turn/completed" {
                    assert_eq!(e["params"]["turn"]["status"], "completed", "{e}");
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(text, "Fixture turn complete.");
        assert_eq!(driver.pid(), Some(pid));
    }
    // A real CLI-managed shell child; killing the driver must kill the group.
    let marker = root.join("child.pid");
    driver.request("command/exec",json!({"command":["sh","-c",format!("sleep 300 >/dev/null 2>&1 & echo $! > {}; wait",marker.display())],"cwd":root,"timeoutMs":100})).await.unwrap();
    let child: i32 = std::fs::read_to_string(&marker)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    driver.cancel().await.unwrap();
    assert!(driver.pid().is_none());
    // A killed child can briefly remain a zombie awaiting its system reaper.
    #[cfg(target_os = "linux")]
    if let Ok(status) = std::fs::read_to_string(format!("/proc/{child}/stat")) {
        assert_eq!(status.split(") ").nth(1).unwrap().chars().next(), Some('Z'));
    }
    #[cfg(not(target_os = "linux"))]
    assert_ne!(unsafe { libc::kill(child, 0) }, 0);
    server.abort();
    std::fs::remove_dir_all(PathBuf::from(root)).unwrap();
}
