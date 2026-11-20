//! Puts the bundled `o8` CLI on PATH by linking it into the first writable
//! well-known bin folder. Shared by the classic shell and the launcher.
//!
//! Order: /opt/homebrew/bin on Apple Silicon, then /usr/local/bin, then
//! ~/.local/bin. A regular file or a user's own link is never replaced. A link
//! left by an earlier install (into an o8.app bundle or a dev build's
//! server/bin/o8) is replaced.
use std::path::{Path, PathBuf};

pub struct Outcome {
    /// The link that now points at the bundled CLI, if any.
    pub path: Option<PathBuf>,
    /// `linked`, `already-linked` or `failed: <details>`, as the server reports it.
    pub status: String,
}

impl Outcome {
    /// Environment the server reads to report the CLI install (`cli-status.ts`).
    pub fn env(&self) -> Vec<(&'static str, String)> {
        let mut env = vec![("O8_CLI_INSTALL_STATUS", self.status.clone())];
        if let Some(path) = &self.path {
            env.push(("O8_CLI_INSTALL_PATH", path.to_string_lossy().into_owned()));
        }
        env
    }
}

pub fn default_targets(home: &Path) -> Vec<PathBuf> {
    let mut targets = Vec::new();
    if cfg!(target_arch = "aarch64") {
        targets.push(PathBuf::from("/opt/homebrew/bin/o8"));
    }
    targets.push(PathBuf::from("/usr/local/bin/o8"));
    targets.push(home.join(".local").join("bin").join("o8"));
    targets
}

#[cfg(unix)]
pub fn link(cli_source: &Path, targets: &[PathBuf]) -> Outcome {
    if !cli_source.exists() {
        return Outcome {
            path: None,
            status: format!("failed: bundled CLI missing at {}", cli_source.display()),
        };
    }
    let mut failures: Vec<String> = Vec::new();
    for target in targets {
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                if let Err(err) = std::fs::create_dir_all(parent) {
                    failures.push(format!("mkdir {} failed: {}", parent.display(), err));
                    continue;
                }
            }
        }
        match std::fs::symlink_metadata(target) {
            Ok(meta) if meta.file_type().is_symlink() => match std::fs::read_link(target) {
                Ok(existing) if existing == cli_source => {
                    return Outcome {
                        path: Some(target.clone()),
                        status: "already-linked".into(),
                    };
                }
                Ok(existing)
                    if existing.to_string_lossy().contains("/Applications/o8.app/")
                        || existing.to_string_lossy().contains("/server/bin/o8") =>
                {
                    // Left by an earlier install or a dev build: replace it.
                    let _ = std::fs::remove_file(target);
                }
                Ok(_) => {
                    failures.push(format!(
                        "{} points to a user-owned symlink",
                        target.display()
                    ));
                    continue;
                }
                Err(_) => {
                    let _ = std::fs::remove_file(target);
                }
            },
            Ok(_) => {
                failures.push(format!("{} exists and is not a symlink", target.display()));
                continue;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                failures.push(format!("stat {} failed: {}", target.display(), err));
                continue;
            }
        }
        match std::os::unix::fs::symlink(cli_source, target) {
            Ok(()) => {
                return Outcome {
                    path: Some(target.clone()),
                    status: "linked".into(),
                };
            }
            Err(err) => failures.push(format!("{} failed: {}", target.display(), err)),
        }
    }
    Outcome {
        path: None,
        status: format!("failed: {}", failures.join("; ")),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("o8-cli-link-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn cli(root: &Path) -> PathBuf {
        let cli = root.join("o8.app/Contents/Resources/server/bin/o8");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "").unwrap();
        cli
    }

    #[test]
    fn links_the_first_free_target_and_reports_it() {
        let root = root("first");
        let cli = cli(&root);
        let targets = [root.join("a/o8"), root.join("b/o8")];
        let outcome = link(&cli, &targets);
        assert_eq!(outcome.status, "linked");
        assert_eq!(outcome.path.as_deref(), Some(targets[0].as_path()));
        assert_eq!(std::fs::read_link(&targets[0]).unwrap(), cli);
        let again = link(&cli, &targets);
        assert_eq!(again.status, "already-linked");
        assert_eq!(
            again.env(),
            vec![
                ("O8_CLI_INSTALL_STATUS", "already-linked".to_owned()),
                (
                    "O8_CLI_INSTALL_PATH",
                    targets[0].to_string_lossy().into_owned()
                ),
            ]
        );
    }

    #[test]
    fn never_replaces_a_file_or_a_users_link_but_replaces_an_old_install() {
        let root = root("keep");
        let cli = cli(&root);
        let file = root.join("file/o8");
        let users = root.join("users/o8");
        let old = root.join("old/o8");
        for target in [&file, &users, &old] {
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        }
        std::fs::write(&file, "mine").unwrap();
        std::os::unix::fs::symlink("/opt/tools/o8", &users).unwrap();
        std::os::unix::fs::symlink(
            "/Applications/o8.app/Contents/Resources/server/bin/o8",
            &old,
        )
        .unwrap();
        let outcome = link(&cli, &[file.clone(), users.clone(), old.clone()]);
        assert_eq!(outcome.status, "linked");
        assert_eq!(outcome.path.as_deref(), Some(old.as_path()));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
        assert_eq!(
            std::fs::read_link(&users).unwrap(),
            PathBuf::from("/opt/tools/o8")
        );
        assert_eq!(std::fs::read_link(&old).unwrap(), cli);
    }

    #[test]
    fn reports_every_refusal_when_nothing_can_be_linked() {
        let root = root("none");
        let cli = cli(&root);
        let file = root.join("file/o8");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "mine").unwrap();
        let outcome = link(&cli, &[file.clone()]);
        assert!(outcome.path.is_none());
        assert!(outcome.status.starts_with("failed: "));
        assert!(outcome.status.contains("exists and is not a symlink"));
        let missing = link(&root.join("absent"), &[root.join("x/o8")]);
        assert!(missing.status.starts_with("failed: bundled CLI missing"));
        assert!(!root.join("x/o8").exists());
    }
}
