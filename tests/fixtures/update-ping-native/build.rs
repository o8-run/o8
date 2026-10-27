//! Instrument only the native fixture: retain production control flow and replace
//! the installer edge plus a deterministic pause in its existing pre-install gap.
use std::{env, fs, path::PathBuf};

fn replace_once(source: &mut String, from: &str, to: &str) {
    assert_eq!(
        source.matches(from).count(),
        1,
        "native fixture edge moved: {from}"
    );
    *source = source.replacen(from, to, 1);
}

fn main() {
    let source = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../src-tauri/src")
        .canonicalize()
        .unwrap();
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("native-source");
    fs::create_dir_all(&output).unwrap();
    for name in [
        "launch_updater.rs",
        "update_scheduler.rs",
        "update_schedule.rs",
        "update_auto_apply.rs",
        "update_install_journal.rs",
        "update_task.rs",
        "update_ping.rs",
        "update_channel_persistence.rs",
    ] {
        let path = source.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        // Windows checkouts use CRLF; the multi-line edges below are written with LF.
        let mut code = fs::read_to_string(path).unwrap().replace("\r\n", "\n");
        if name == "update_channel_persistence.rs" {
            replace_once(&mut code, "    std::fs::rename(&temporary, path)",
                "    crate::channel_save_edge::before_commit(path, &temporary)?;\n    std::fs::rename(&temporary, path)");
        }
        if name == "update_schedule.rs" {
            replace_once(
                &mut code,
                "#[path = \"../../tests/native-update-schedule.rs\"]",
                &format!(
                    "#[path = {:?}]",
                    source
                        .join("../../tests/native-update-schedule.rs")
                        .canonicalize()
                        .unwrap()
                ),
            );
        }
        if name == "update_ping.rs" {
            replace_once(&mut code, "    let installation = clock\n        .installation",
                "    crate::install_race_edge::before_gate(app);\n    let installation = clock\n        .installation");
            replace_once(&mut code, "    let _installing = downloaded", "    crate::install_race_edge::before_install(webview.app_handle());\n    let _installing = downloaded");
            replace_once(&mut code, "downloaded.checked.update.install(&downloaded.bytes)",
                "crate::install_race_edge::install(webview.app_handle(), &downloaded.checked.update, &downloaded.bytes)");
        }
        if name == "update_auto_apply.rs" {
            replace_once(&mut code, "        let installed =", "        crate::install_race_edge::before_install(&self.app);\n        let installed =");
            replace_once(
                &mut code,
                "update.install(bytes)",
                "crate::install_race_edge::install(&self.app, &update, bytes)",
            );
        }
        fs::write(output.join(name), code).unwrap();
    }
    let modules = format!(
        "#[path = {:?}]\nmod launch_updater;\n#[path = {:?}]\nmod update_ping;\n",
        output.join("launch_updater.rs"),
        output.join("update_ping.rs")
    );
    fs::write(output.parent().unwrap().join("native_modules.rs"), modules).unwrap();
}
