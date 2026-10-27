use std::process::Command;

#[test]
fn app_shell_is_explicit_and_documents_persistence() {
    let binary = env!("CARGO_BIN_EXE_o8-next");
    let help = Command::new(binary).arg("--help").output().unwrap();
    assert!(help.status.success());
    let help = String::from_utf8_lossy(&help.stdout);
    assert!(help.contains("--app-shell"));
    assert!(help.contains("--shell-state"));
    for args in [
        vec!["--app-shell"],
        vec!["--enable-next", "--app-shell"],
        vec![
            "--enable-next",
            "--app-shell",
            "--server",
            "http://127.0.0.1:1",
            "--shell-state",
            "relative.json",
        ],
    ] {
        let result = Command::new(binary).args(args).output().unwrap();
        assert_eq!(result.status.code(), Some(1));
    }
}

#[test]
fn invalid_shell_state_is_retained_through_native_entrypoint() {
    let root = std::env::temp_dir().join(format!("o8-shell-state-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let file = root.join("state.json");
    for bytes in [b"{\"version\":999}".to_vec(), vec![b' '; 1024 * 1024 + 1]] {
        std::fs::write(&file, &bytes).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_o8-next"))
            .args(["--enable-next", "--app-shell", "--shell-state"])
            .arg(&file)
            .args(["--server", "invalid", "--offscreen"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains("Invalid server URL"),
            "state recovery must reach the normal server validation: {error}"
        );
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unreadable_shell_state_does_not_abort_native_startup() {
    let root = std::env::temp_dir().join(format!("o8-shell-unreadable-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_o8-next"))
        .args(["--enable-next", "--app-shell", "--shell-state"])
        .arg(&root)
        .args(["--server", "invalid", "--offscreen"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("Invalid server URL"),
        "an unreadable state must reach normal server validation: {error}"
    );
    assert!(root.is_dir());
    std::fs::remove_dir_all(root).unwrap();
}
