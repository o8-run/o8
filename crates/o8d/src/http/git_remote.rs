//! The sidebar's origin URL per repository, kept while the repository's config
//! file is the same file. `git remote get-url` costs a process spawn (about
//! 2 ms) per repository per list; this skips it until the answer can differ.
//!
//! The TS reader (`src/lib/repos/github-identity.ts`) keeps each answer for
//! 5 s whatever changes. Here an answer is also dropped as soon as the
//! repository's config file changes (`git remote set-url`, `remove`, a
//! re-clone), so that edit is seen at once when the config is found by
//! walking up to `.git`. Anything this walk does not track can be up to 5 s
//! stale, the same bound as TS: a bare repository, `GIT_DIR` or `GIT_CONFIG*`
//! in the daemon's environment, `include` files, a symlinked path, settings
//! outside the repository such as a global `url.<base>.insteadOf`, and a
//! failed read.
use super::thread_context::resolve;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const MAX_AGE: Duration = Duration::from_secs(5);
const MAX_ENTRIES: usize = 256;

#[derive(PartialEq, Eq, Clone, Copy)]
struct FileKey {
    device: u64,
    inode: u64,
    size: u64,
    modified_ns: i128,
}

struct Entry {
    config: Vec<Option<FileKey>>,
    read_at: Instant,
    url: Option<String>,
}

static CACHE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);
#[cfg(test)]
pub(super) static SPAWNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// `git -C <repo> remote get-url origin`, reused while the config is unchanged.
pub(super) fn origin(repo: &str) -> Option<String> {
    if repo.is_empty() {
        return None;
    }
    let config = config_files(Path::new(repo))
        .iter()
        .map(|path| key(path))
        .collect::<Vec<_>>();
    if let Ok(cache) = CACHE.lock() {
        if let Some(entry) = cache.as_ref().and_then(|cache| cache.get(repo)) {
            if entry.config == config && entry.read_at.elapsed() < MAX_AGE {
                return entry.url.clone();
            }
        }
    }
    let read_at = Instant::now();
    #[cfg(test)]
    SPAWNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let url = std::process::Command::new("git")
        .args(["-C", repo, "remote", "get-url", "origin"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok());
    if let Ok(mut cache) = CACHE.lock() {
        let cache = cache.get_or_insert_with(HashMap::new);
        if cache.len() >= MAX_ENTRIES && !cache.contains_key(repo) {
            cache.clear();
        }
        // Identities read before the spawn: a config written meanwhile differs
        // on the next read, so it is never served from this entry.
        cache.insert(
            repo.to_owned(),
            Entry {
                config,
                read_at,
                url: url.clone(),
            },
        );
    }
    url
}

/// The repository config files git reads for this checkout: the common
/// `config`, plus `config.worktree` for a linked checkout. Empty outside a
/// repository; then only the age bound applies, as in TS.
fn config_files(repo: &Path) -> Vec<PathBuf> {
    let mut directory = resolve(repo);
    loop {
        let dot_git = directory.join(".git");
        if let Ok(metadata) = std::fs::metadata(&dot_git) {
            let git = if metadata.is_dir() {
                Some(dot_git)
            } else {
                std::fs::read_to_string(&dot_git).ok().and_then(|contents| {
                    contents.lines().find_map(|line| {
                        line.strip_prefix("gitdir:")
                            .map(str::trim)
                            .filter(|path| !path.is_empty())
                            .map(|path| resolve(&directory.join(path)))
                    })
                })
            };
            let Some(git) = git else {
                return Vec::new();
            };
            let common = std::fs::read_to_string(git.join("commondir"))
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|s| resolve(&git.join(s.trim())))
                .unwrap_or_else(|| git.clone());
            return vec![common.join("config"), git.join("config.worktree")];
        }
        if !directory.pop() {
            return Vec::new();
        }
    }
}

#[cfg(unix)]
fn key(path: &Path) -> Option<FileKey> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileKey {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.size(),
        modified_ns: i128::from(metadata.mtime()) * 1_000_000_000
            + i128::from(metadata.mtime_nsec()),
    })
}

/// Without a file identity, only the age bound applies, as in TS.
#[cfg(not(unix))]
fn key(_: &Path) -> Option<FileKey> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn git(repo: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn a_config_change_is_seen_at_once_from_the_checkout_and_its_linked_worktree() {
        let directory = std::env::temp_dir().join(format!("o8d-git-remote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let repo = directory.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "--quiet"]);
        git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/fixture/first.git",
            ],
        );
        git(
            &repo,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--no-gpg-sign",
                "--allow-empty",
                "--quiet",
                "-m",
                "fixture",
            ],
        );
        let linked = directory.join("linked");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "linked",
                linked.to_str().unwrap(),
            ],
        );
        let nested = linked.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let (repo_path, nested_path) = (repo.to_str().unwrap(), nested.to_str().unwrap());
        let spawns = || SPAWNS.load(Ordering::SeqCst);

        let before = spawns();
        assert_eq!(
            origin(repo_path).unwrap().trim(),
            "https://github.com/fixture/first.git"
        );
        assert_eq!(
            origin(nested_path).unwrap().trim(),
            "https://github.com/fixture/first.git"
        );
        assert_eq!(spawns() - before, 2, "one read per repository path");
        assert_eq!(
            origin(repo_path).unwrap().trim(),
            "https://github.com/fixture/first.git"
        );
        assert_eq!(
            origin(nested_path).unwrap().trim(),
            "https://github.com/fixture/first.git"
        );
        assert_eq!(
            spawns() - before,
            2,
            "an unchanged config is not read again"
        );

        // The linked checkout shares the main repository's config.
        git(
            &repo,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/fixture/second.git",
            ],
        );
        assert_eq!(
            origin(nested_path).unwrap().trim(),
            "https://github.com/fixture/second.git"
        );
        assert_eq!(
            origin(repo_path).unwrap().trim(),
            "https://github.com/fixture/second.git"
        );
        git(&repo, &["remote", "remove", "origin"]);
        assert_eq!(origin(repo_path), None);
        assert_eq!(spawns() - before, 5);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
