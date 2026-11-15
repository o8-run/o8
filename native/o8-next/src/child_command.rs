//! External tools retain the host environment, never the window's automatic ICD selection.
use std::{ffi::OsStr, process::Command};

pub(crate) fn automatic_vulkan() -> bool {
    std::env::var("O8_APPIMAGE_SOFTWARE_VULKAN").as_deref() == Ok("1")
}

pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    // Explicit user driver choices are inherited normally. Only our automatic
    // software fallback belongs to this window rather than its editor/tools.
    if automatic_vulkan() {
        command.env_remove("VK_ICD_FILENAMES");
        command.env_remove("VK_DRIVER_FILES");
    }
    command.env_remove("O8_APPIMAGE_SOFTWARE_VULKAN");
    command.env_remove("O8_NEXT_READY_STDOUT");
    command
}

#[cfg(all(test, unix))]
mod tests {
    use super::command;
    use std::process::Command;

    #[test]
    fn environment_probe() {
        let Ok(mode) = std::env::var("O8_CHILD_ENV_PROBE") else {
            return;
        };
        let output = command("sh").args(["-c", "env"]).output().unwrap();
        assert!(output.status.success());
        let env = String::from_utf8(output.stdout).unwrap();
        assert!(
            env.lines()
                .any(|line| line == "LD_LIBRARY_PATH=/fixture/user-libraries")
        );
        assert!(!env.contains("O8_NEXT_READY_STDOUT="));
        assert!(!env.contains("O8_APPIMAGE_SOFTWARE_VULKAN="));
        if mode == "automatic" {
            assert!(!env.contains("VK_ICD_FILENAMES="));
            assert!(!env.contains("VK_DRIVER_FILES="));
        } else {
            assert!(env.contains("VK_ICD_FILENAMES=/fixture/user-icd.json"));
            assert!(env.contains("VK_DRIVER_FILES=/fixture/user-icd.json"));
        }
    }

    #[test]
    fn child_tools_drop_automatic_icd_but_preserve_explicit_host_environment() {
        for mode in ["automatic", "explicit"] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["environment_probe", "--nocapture"])
                .env("O8_CHILD_ENV_PROBE", mode)
                .env(
                    "O8_APPIMAGE_SOFTWARE_VULKAN",
                    if mode == "automatic" { "1" } else { "0" },
                )
                .env("VK_ICD_FILENAMES", "/fixture/user-icd.json")
                .env("VK_DRIVER_FILES", "/fixture/user-icd.json")
                .env("LD_LIBRARY_PATH", "/fixture/user-libraries")
                .env("O8_NEXT_READY_STDOUT", "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        }
    }
}
