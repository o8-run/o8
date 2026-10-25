//! Bounded native media processing. All paths are assigned by the capture owner.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn helper(directory: &Path, mode: &str) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join(format!("{mode}-helper"));
    let bytes = include_bytes!(env!("O8_VISUAL_CAPTURE_MEDIA"));
    std::fs::write(&path, bytes).map_err(|_| "Could not prepare capture media processing.")?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "Could not protect capture media processing.")?;
    Ok(path)
}

pub fn run(
    directory: &Path,
    mode: &str,
    source: &Path,
    argument: &str,
    cancelled: &AtomicBool,
) -> Result<serde_json::Value, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Visual capture was cancelled.".into());
    }
    let binary = helper(directory, mode)?;
    let output = directory.join(format!("{mode}-result.json"));
    let mut child = crate::child_environment::command(&binary)
        .arg(mode)
        .arg(source)
        .arg(&output)
        .arg(argument)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "Could not start capture media processing.")?;
    let deadline = Instant::now() + Duration::from_secs(if mode == "transcribe" { 20 } else { 45 });
    let result = wait(&mut child, deadline, cancelled);
    let _ = std::fs::remove_file(&binary);
    result?;
    let metadata = std::fs::metadata(&output).map_err(|_| "Capture media result is missing.")?;
    if metadata.len() > 2_000_000 {
        return Err("Capture media result is too large.".into());
    }
    let bytes = std::fs::read(output).map_err(|_| "Could not read capture media result.")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid capture media result.".into())
}

fn wait(
    child: &mut std::process::Child,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let result = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            break Err("Visual capture was cancelled.");
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err("Capture media processing was unavailable.")
                }
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("Capture media processing timed out.");
            }
        }
    };
    result.map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_kills_and_reaps_the_media_child() {
        let cancelled = AtomicBool::new(true);
        let mut child = crate::child_environment::command("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let started = Instant::now();
        assert!(
            wait(&mut child, started + Duration::from_secs(45), &cancelled)
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
    }
    #[test]
    fn real_decoder_preserves_distinct_video_moments_and_rejects_truncation() {
        let directory =
            std::env::temp_dir().join(format!("o8-visual-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("recording.mp4");
        // Four seconds: two red, then two blue. Generated without external media.
        std::fs::write(
            &source,
            include_bytes!("../tests/fixtures/visual-capture.mp4"),
        )
        .unwrap();
        let cancelled = AtomicBool::new(false);
        let result = run(&directory, "frames", &source, "[100,2500]", &cancelled).unwrap();
        assert_eq!(result["frames"].as_array().unwrap().len(), 2);
        let first = image::open(directory.join("source-1.png"))
            .unwrap()
            .to_rgba8();
        let second = image::open(directory.join("source-2.png"))
            .unwrap()
            .to_rgba8();
        assert_eq!(first.dimensions(), (160, 96));
        assert!(first.get_pixel(80, 48)[0] > 240 && first.get_pixel(80, 48)[2] < 10);
        assert!(second.get_pixel(80, 48)[2] > 240 && second.get_pixel(80, 48)[0] < 10);
        assert!(run(&directory, "frames", &source, "[5000]", &cancelled).is_err());
        assert!(!directory.join("frames-helper").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
