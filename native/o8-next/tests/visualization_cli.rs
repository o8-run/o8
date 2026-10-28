#[cfg(target_os = "macos")]
#[test]
fn webkit_sandbox_theme_and_restored_state_through_the_visualization_route() {
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
    };
    struct Host(Child);
    impl Drop for Host {
        fn drop(&mut self) {
            let _ = Command::new("kill")
                .args(["-TERM", &self.0.id().to_string()])
                .status();
            let _ = self.0.wait();
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::temp_dir().join(format!("o8-visualization-sandbox-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let requests = dir.join("requests.json");
    let child = Command::new("node")
        .current_dir(root)
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/dev-server.ts",
            "--visualizations",
        ])
        .env("O8_NEXT_API_TOKEN", "visualization-fixture-token")
        .env("O8_NEXT_REQUEST_LOG", &requests)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut host = Host(child);
    let mut lines = BufReader::new(host.0.stdout.take().unwrap()).lines();
    let origin = lines
        .find_map(|line| {
            serde_json::from_str::<serde_json::Value>(&line.ok()?).ok()?["origin"]
                .as_str()
                .map(str::to_owned)
        })
        .expect("fixture origin");
    std::thread::spawn(move || for _ in lines {});
    let nonce = "native-sandbox-fixture-0123456789";
    let route = format!(
        "{origin}/api/visualizations/vis-49720000-0000-4000-8000-000000000003?nativeNonce={nonce}"
    );
    let body: serde_json::Value = ureq::get(&route)
        .set("Authorization", "Bearer visualization-fixture-token")
        .call()
        .unwrap()
        .into_json()
        .unwrap();
    let html = dir.join("document.html");
    std::fs::write(&html, body["result"]["sealedHtml"].as_str().unwrap()).unwrap();
    let output = dir.join("result.json");
    let result = Command::new(env!("CARGO_BIN_EXE_o8-next-visualization-check"))
        .arg(&html)
        .args([nonce, &origin])
        .arg(&output)
        .output()
        .unwrap();
    let receipt = std::fs::read_to_string(&output).unwrap_or_default();
    assert!(
        result.status.success(),
        "sandbox process: {} {receipt}",
        String::from_utf8_lossy(&result.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
    assert_eq!(receipt["height"].as_f64(), Some(240.));
    assert_eq!(receipt["dark"], true);
    assert_eq!(receipt["light"], true);
    drop(host);
    let calls: Vec<String> = serde_json::from_slice(&std::fs::read(&requests).unwrap()).unwrap();
    assert!(
        !calls.iter().any(|call| call.contains("sandbox-")),
        "untrusted document reached the route host: {calls:?}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
