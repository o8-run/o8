//! Explicit native run: cargo build --example window-occlusion, then provide
//! O8_NEXT_OCCLUSION_BINARY and O8_NEXT_OCCLUSION_DIR to this integration test.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires macOS native rendering; reads pixels from owned inactive windows"]
fn hidden_glass_text_pixels_click_and_reduced_transparency() {
    use std::{
        fs,
        path::PathBuf,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let binary =
        fs::canonicalize(std::env::var("O8_NEXT_OCCLUSION_BINARY").expect("built native probe"))
            .unwrap();
    let directory =
        fs::canonicalize(std::env::var("O8_NEXT_OCCLUSION_DIR").expect("owned output directory"))
            .unwrap();
    for reduced in [false, true] {
        let mut command = Command::new(&binary);
        if reduced {
            command.arg("--reduced");
        }
        let mut child = command
            .env("O8_NEXT_APPEARANCE", "glass")
            .env("O8_NEXT_OCCLUSION_DIR", &directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("native occlusion probe did not finish within its deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "native {reduced} probe failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let mode = if reduced { "reduced" } else { "glass" };
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join(format!("{mode}.json"))).unwrap())
                .unwrap();
        assert!(receipt["contrastTextPixels"].as_u64().unwrap() > 80);
        assert_eq!(receipt["clicks"], 1);
        assert_eq!(receipt["activated"], false);
        assert_eq!(receipt["actualFrame"].as_array().unwrap().len(), 4);
        assert!(
            fs::metadata(PathBuf::from(&directory).join(format!("{mode}.png")))
                .unwrap()
                .len()
                > 1000
        );
    }
}
