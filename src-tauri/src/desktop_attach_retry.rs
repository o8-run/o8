//! A pre-window recovery prompt. No backend or profile mutation is allowed here.

pub(crate) fn prompt_retry() -> bool {
    let title = "Reconnect to o8";
    let body = "A background o8 server is still running, but it could not be verified yet. Retry to reconnect. Your running work stays open.\n\nIf the server uses a different version, update it before reconnecting.";

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display dialog {:?} with title {:?} buttons {{\"Quit\", \"Retry\"}} default button \"Retry\" cancel button \"Quit\"",
            body, title
        );
        crate::child_environment::command("osascript")
            .args(["-e", &script])
            .output()
            .map(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).trim() == "button returned:Retry"
            })
            .unwrap_or(false)
    }
    #[cfg(target_os = "windows")]
    {
        use crate::no_window::NoWindow;
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.MessageBox]::Show('{}','{}','RetryCancel','Warning') -eq 'Retry') {{ exit 0 }} else {{ exit 1 }}",
            body.replace('\'', "''"), title.replace('\'', "''")
        );
        crate::child_environment::command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .no_window()
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let result = crate::child_environment::command("zenity")
            .args([
                "--question",
                "--title",
                title,
                "--text",
                body,
                "--ok-label",
                "Retry",
                "--cancel-label",
                "Quit",
            ])
            .status()
            .or_else(|_| {
                crate::child_environment::command("kdialog")
                    .args([
                        "--yesno",
                        body,
                        "--title",
                        title,
                        "--yes-label",
                        "Retry",
                        "--no-label",
                        "Quit",
                    ])
                    .status()
            });
        if result.is_err() {
            eprintln!("{title}: {body}");
        }
        result.map(|status| status.success()).unwrap_or(false)
    }
}
