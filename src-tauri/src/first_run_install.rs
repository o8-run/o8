use std::path::{Path, PathBuf};

const DEST_APP: &str = "/Applications/o8.app";

fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn enclosing_app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(Path::to_path_buf)
}

fn is_dmg_or_translocated(path: &Path) -> bool {
    let path = path.to_string_lossy();
    path.starts_with("/Volumes/") || path.contains("/AppTranslocation/")
}

fn user_wants_move(source_app: &Path) -> bool {
    let body = format!(
        "o8 is running from a disk image or temporary macOS copy. Move it to Applications now so permissions and automatic updates work correctly?\n\nSource: {}",
        source_app.display()
    );
    let script = format!(
        r#"display dialog "{}" with title "Move o8 to Applications" buttons {{"Quit", "Move to Applications"}} default button "Move to Applications" cancel button "Quit" with icon caution"#,
        escape_applescript(&body)
    );
    crate::child_environment::command("osascript")
        .args(["-e", &script])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .is_some_and(|stdout| stdout.contains("Move to Applications"))
}

fn spawn_move_and_relaunch(source_app: &Path) -> std::io::Result<()> {
    let script = r#"
set -eu
sleep 0.5
rm -rf "$O8_DEST_APP"
/usr/bin/ditto "$O8_SOURCE_APP" "$O8_DEST_APP"
/usr/bin/xattr -dr com.apple.quarantine "$O8_DEST_APP" 2>/dev/null || true
/usr/bin/open "$O8_DEST_APP"
"#;
    crate::child_environment::command("/bin/sh")
        .arg("-c")
        .arg(script)
        .env("O8_SOURCE_APP", source_app)
        .env("O8_DEST_APP", DEST_APP)
        .spawn()
        .map(|_| ())
}

pub fn offer_move_to_applications_if_needed() {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return,
    };
    if !is_dmg_or_translocated(&exe) {
        return;
    }

    let Some(source_app) = enclosing_app_bundle(&exe) else {
        log::warn!(
            "[first-run-install] could not resolve .app bundle for {}",
            exe.display()
        );
        return;
    };
    log::warn!(
        "[first-run-install] o8 is running from {} — offering move to {}",
        source_app.display(),
        DEST_APP
    );

    if !user_wants_move(&source_app) {
        return;
    }

    match spawn_move_and_relaunch(&source_app) {
        Ok(()) => std::process::exit(0),
        Err(err) => {
            log::warn!("[first-run-install] move helper failed to launch: {}", err);
        }
    }
}
