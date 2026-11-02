//! This must use the production executable: unit builds skip Port::own.
#[cfg(target_os = "linux")]
#[test]
fn terminal_own_shell_creates_once_reuses_and_accepts_input() {
    use std::{path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    // Cargo's integration-test build unifies GPUI's dev-only test-support
    // feature into CARGO_BIN_EXE. Rebuild the ordinary debug app so this path
    // uses the native frame driver, not GPUI's test driver.
    let build = Command::new(env!("CARGO"))
        .args(["build", "--locked", "--manifest-path"])
        .arg(root.join("native/o8-next/Cargo.toml"))
        .args(["--bin", "o8-next", "-j", "4"])
        .current_dir(&root)
        .output()
        .expect("build the ordinary debug application");
    assert!(
        build.status.success(),
        "ordinary debug build failed: {}",
        String::from_utf8_lossy(&build.stderr)
    );
    let output = Command::new("xvfb-run")
        .args([
            "--auto-servernum",
            "--server-args=-screen 0 1280x900x24 -nolisten tcp",
            "node",
        ])
        .arg(root.join("native/o8-next/test-support/terminal-own-shell.mjs"))
        .arg(env!("CARGO_BIN_EXE_o8-next"))
        .current_dir(root)
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .expect("real-window test requires Xvfb, xauth, xdotool and software Vulkan");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    print!("{stdout}");
}
