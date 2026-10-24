use std::process::Command;

#[test]
fn pane_grid_is_an_explicit_native_opt_in() {
    let binary = env!("CARGO_BIN_EXE_o8-next");
    let help = Command::new(binary).arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&help.stdout).contains("--pane-grid 1|2|4|6"));
    for count in ["0", "3", "7", "6"] {
        // Even a valid size cannot discover a workspace or layout file implicitly.
        let output = Command::new(binary)
            .args([
                "--enable-next",
                "--pane-grid",
                count,
                "--server",
                "http://127.0.0.1:1",
            ])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("Unknown argument"));
    }
}

#[test]
fn pane_grid_rejects_invalid_persistence_before_window_startup() {
    let binary = env!("CARGO_BIN_EXE_o8-next");
    let root = std::env::temp_dir().join(format!("o8-grid-cli-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let file = root.join("layout.json");
    std::fs::write(&file, b"{invalid").unwrap();
    let args = [
        "--pane-grid",
        "6",
        "--workspace",
        root.to_str().unwrap(),
        "--pane-layout",
        file.to_str().unwrap(),
        "--server",
        "http://127.0.0.1:1",
    ];
    let disabled = Command::new(binary).args(args).output().unwrap();
    assert!(!disabled.status.success());
    assert!(String::from_utf8_lossy(&disabled.stderr).contains("pass --enable-next"));
    let invalid = Command::new(binary)
        .arg("--enable-next")
        .args(args)
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("Invalid pane layout"));
    assert_eq!(std::fs::read(&file).unwrap(), b"{invalid");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn grid_rejects_conflicting_terminal_mode_and_invalid_slot_views() {
    let binary = env!("CARGO_BIN_EXE_o8-next");
    let root = std::env::temp_dir().join(format!("o8-grid-views-cli-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let file = root.join("layout.json");
    for views in [
        serde_json::json!([]),
        serde_json::json!([
            "shell",
            "transcript",
            "transcript",
            "transcript",
            "transcript",
            "transcript"
        ]),
    ] {
        let original = serde_json::json!({root.to_str().unwrap(): {
            "size":6,"sessions":[null,null,null,null,null,null],"focus":0,"views":views
        }})
        .to_string();
        std::fs::write(&file, &original).unwrap();
        let output = Command::new(binary)
            .args([
                "--enable-next",
                "--offscreen",
                "--pane-grid",
                "6",
                "--workspace",
                root.to_str().unwrap(),
                "--pane-layout",
                file.to_str().unwrap(),
                "--server",
                "http://127.0.0.1:1",
            ])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&output.stderr).contains("Invalid pane layout"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
    }
    let output = Command::new(binary)
        .args([
            "--enable-next",
            "--offscreen",
            "--pane-grid",
            "6",
            "--workspace",
            root.to_str().unwrap(),
            "--pane-layout",
            file.to_str().unwrap(),
            "--server",
            "http://127.0.0.1:1",
            "--terminal",
            "fixture",
        ])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&output.stderr).contains("Use per-slot terminal selection"));
    std::fs::remove_dir_all(root).unwrap();
}
