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

/// `command`, with Windows shim resolution. Editor CLIs install as `.cmd`
/// shims (VS Code ships `code.cmd`), but std searches PATH for the exact name
/// and `name.exe` only, so a bare `code` never finds one and the spawn fails
/// with "program not found". Mirror the desktop's `cli-spawn.ts` (issue
/// #1758): resolve the shim on PATH and route non-executables through the
/// interpreter explicitly — never a `shell: true` equivalent, so arguments
/// keep their per-argument quoting.
///
/// Only the editor uses this: callers that later kill the child (`speech`)
/// must keep the program itself as the direct child, because killing cmd.exe
/// would leave the real tool running — the desktop pairs its interpreter
/// route with `taskkill /T` for the same reason. The editor only waits on
/// the child's status, so the interpreter in between costs it nothing.
pub(crate) fn shim_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = shim_target(program.as_ref());
    if automatic_vulkan() {
        command.env_remove("VK_ICD_FILENAMES");
        command.env_remove("VK_DRIVER_FILES");
    }
    command.env_remove("O8_APPIMAGE_SOFTWARE_VULKAN");
    command.env_remove("O8_NEXT_READY_STDOUT");
    command
}

#[cfg(not(windows))]
fn shim_target(program: &OsStr) -> Command {
    Command::new(program)
}

#[cfg(windows)]
fn shim_target(program: &OsStr) -> Command {
    let path = std::path::Path::new(program);
    let bare = path
        .parent()
        .is_none_or(|parent| parent.as_os_str().is_empty());
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase());
    if bare {
        match extension.as_deref() {
            Some("exe") | Some("com") => return Command::new(program),
            // An extensioned shim (`code.cmd`): std finds it on PATH, but
            // CreateProcess cannot start the file without the interpreter.
            Some(_) => return interpreted(program),
            None => {
                if let Some(resolved) = resolve_bare(
                    path.file_name().unwrap_or(program),
                    &std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                        .collect::<Vec<_>>(),
                ) {
                    return resolved;
                }
            }
        }
    }
    Command::new(program)
}

/// Resolves a bare name across `dirs` the way `where` does, executables
/// before shims, first hit wins.
#[cfg(windows)]
fn resolve_bare(name: &OsStr, dirs: &[std::path::PathBuf]) -> Option<Command> {
    let name = name.to_str()?;
    for dir in dirs {
        for extension in ["exe", "com", "cmd", "bat"] {
            let candidate = dir.join(format!("{name}.{extension}"));
            if candidate.is_file() {
                return Some(if extension == "exe" || extension == "com" {
                    Command::new(candidate)
                } else {
                    interpreted(candidate.as_os_str())
                });
            }
        }
    }
    None
}

/// Starts `program` through the interpreter: `/d` skips any AutoRun command a
/// user configured in the registry, which would otherwise run before the tool
/// on every single spawn.
#[cfg(windows)]
fn interpreted(program: &OsStr) -> Command {
    let comspec = match std::env::var_os("ComSpec") {
        Some(comspec) if !comspec.is_empty() => comspec,
        _ => OsStr::new("cmd.exe").to_os_string(),
    };
    let mut command = Command::new(comspec);
    command.args(["/d", "/c"]).arg(program);
    command
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::{interpreted, resolve_bare, shim_command};
    use std::ffi::OsStr;
    use std::path::PathBuf;

    fn fixture_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("o8-child-command-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_bare_name_prefers_the_executable_and_routes_shims_through_the_interpreter() {
        let dir = fixture_dir("resolve");
        std::fs::write(dir.join("tool.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(dir.join("tool.bat"), "@echo off\r\n").unwrap();

        let command = resolve_bare(OsStr::new("tool"), &[dir.clone()]).unwrap();
        let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        assert_eq!(
            command.get_program(),
            comspec,
            "shims start through ComSpec"
        );
        let args: Vec<_> = command.get_args().collect();
        let shim = dir.join("tool.cmd");
        assert_eq!(
            args,
            [OsStr::new("/d"), OsStr::new("/c"), shim.as_os_str()],
            "the interpreter routes to the first shim, not the .bat behind it"
        );

        std::fs::write(dir.join("tool.exe"), b"MZ").unwrap();
        let command = resolve_bare(OsStr::new("tool"), &[dir.clone()]).unwrap();
        assert_eq!(
            command.get_program(),
            dir.join("tool.exe").as_os_str(),
            "the executable wins over the shims"
        );

        assert!(
            resolve_bare(OsStr::new("absent"), &[dir.clone()]).is_none(),
            "an unresolvable name stays unresolved for std's usual error"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_extensioned_shim_name_routes_through_the_interpreter_without_a_path_search() {
        let command = interpreted(OsStr::new("code.cmd"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [OsStr::new("/d"), OsStr::new("/c"), OsStr::new("code.cmd")],
            "cmd.exe resolves the name itself; /d keeps registry AutoRun out"
        );
    }

    #[test]
    fn the_editor_spawn_drops_the_window_environment_like_every_other_child() {
        let command = shim_command("o8-no-such-program");
        assert_eq!(command.get_program(), OsStr::new("o8-no-such-program"));
        // The removals are observable only through the spawned process; the
        // editor integration tests assert the behavior end to end. Here we
        // only pin that an unresolvable name survives resolution untouched,
        // whatever the machine has installed.
        assert!(command.get_args().count() == 0);
    }
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
