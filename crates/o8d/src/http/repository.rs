//! Read-only repository observations with request-local work and a bounded snapshot cache.
use super::*;
use std::{
    cell::Cell,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};

const PROJECTION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BRANCHES: usize = 512;
thread_local! {
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}
struct Deadline(Option<Instant>);
impl Deadline {
    fn start() -> Self {
        Self(DEADLINE.replace(Some(Instant::now() + PROJECTION_TIMEOUT)))
    }
}
impl Drop for Deadline {
    fn drop(&mut self) {
        DEADLINE.set(self.0);
    }
}
fn cancelled() -> bool {
    *shutdown_channel().borrow()
        || DEADLINE
            .get()
            .is_some_and(|deadline| Instant::now() >= deadline)
}
fn projection_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

fn shutdown_channel() -> &'static tokio::sync::watch::Sender<bool> {
    static SHUTDOWN: OnceLock<tokio::sync::watch::Sender<bool>> = OnceLock::new();
    SHUTDOWN.get_or_init(|| tokio::sync::watch::channel(false).0)
}

pub(super) fn shutdown() {
    shutdown_channel().send_replace(true);
}

struct Snapshot {
    generation: String,
    body: Value,
    used: u64,
    refreshing: bool,
}
#[derive(Default)]
struct Snapshots {
    clock: u64,
    entries: HashMap<String, Snapshot>,
}
fn snapshots() -> &'static Mutex<Snapshots> {
    static SNAPSHOTS: OnceLock<Mutex<Snapshots>> = OnceLock::new();
    SNAPSHOTS.get_or_init(|| Mutex::new(Snapshots::default()))
}

pub(super) fn response(status: StatusCode, body: Value) -> Response {
    let mut response = reply(status, body);
    response.headers_mut().insert(
        "x-o8d-native-repository-read",
        axum::http::HeaderValue::from_static("1"),
    );
    response
}

/// Drain output while the process runs, bounding both bytes and elapsed time.
/// This runs on the HTTP dispatcher's blocking worker, never a Tokio reactor.
fn command(program: &str, args: &[&str], timeout_ms: u64, limit: usize) -> Result<String, ()> {
    let remaining = DEADLINE
        .get()
        .map(|deadline| deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(PROJECTION_TIMEOUT);
    let timeout = Duration::from_millis(timeout_ms).min(remaining);
    if timeout.is_zero() {
        return Err(());
    }
    tokio::runtime::Handle::current().block_on(async {
        let mut shutdown = shutdown_channel().subscribe();
        if *shutdown.borrow() {
            return Err(());
        }
        let mut child = Command::new(program)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ())?;
        let stdout = child.stdout.take().ok_or(())?;
        let operation = async {
            let mut bytes = Vec::new();
            stdout
                .take(limit as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| ())?;
            if bytes.len() > limit {
                return Err(());
            }
            if !child.wait().await.map_err(|_| ())?.success() {
                return Err(());
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        };
        let result = tokio::select! {
            _ = shutdown.changed() => Err(()),
            result = tokio::time::timeout(timeout, operation) => result.unwrap_or(Err(())),
        };
        if result.is_err() {
            let _ = child.kill().await;
        }
        result
    })
}

pub(super) fn git(repo: &str, args: &[&str], timeout_ms: u64, limit: usize) -> Result<String, ()> {
    let mut arguments = vec!["-C", repo];
    arguments.extend_from_slice(args);
    command("git", &arguments, timeout_ms, limit)
}

fn branch_git(repo: &str, args: &[&str], timeout_ms: u64) -> Result<String, ()> {
    git(repo, args, timeout_ms, 1024 * 1024).map(|raw| raw.trim().to_owned())
}

fn shortstat(raw: &str) -> (i64, i64) {
    let words: Vec<_> = raw.split_whitespace().collect();
    let count = |prefix| {
        words
            .windows(2)
            .find(|pair| pair[1].starts_with(prefix))
            .and_then(|pair| pair[0].parse::<i64>().ok())
            .unwrap_or(0)
    };
    (count("insertion"), count("deletion"))
}

fn generation(repo: &str) -> Option<String> {
    let head = branch_git(repo, &["rev-parse", "--verify", "HEAD"], 2000)
        .ok()
        .filter(|head| !head.is_empty())?;
    let refs = branch_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
            "refs/heads/",
        ],
        3000,
    )
    .unwrap_or_default();
    Some(format!("{head}\n{refs}"))
}

fn supports_native_projection(repo: &str) -> bool {
    if std::env::var_os("GIT_EXTERNAL_DIFF").is_some() {
        return false;
    }
    // Query effective keys, including system/global/conditional/worktree config,
    // without reading credential values. Helpers can mutate state even on a
    // --quiet diff; promisor repositories can fetch objects during tree reads.
    let Ok(keys) = branch_git(
        repo,
        &["config", "--includes", "--null", "--name-only", "--list"],
        2000,
    ) else {
        return false;
    };
    !keys.split('\0').any(|key| {
        let key = key.to_ascii_lowercase();
        key == "diff.external"
            || key == "extensions.partialclone"
            || (key.starts_with("diff.")
                && (key.ends_with(".command") || key.ends_with(".textconv")))
            || (key.starts_with("remote.") && key.ends_with(".promisor"))
    })
}

fn compute_branches(repo: &str, has_generation: bool) -> ReadResult {
    // The TS snapshot accepts a readable HEAD in a bare repository too. Its
    // worktree probe belongs only to the fallback when no snapshot can exist.
    if !has_generation
        && branch_git(repo, &["rev-parse", "--is-inside-work-tree"], 2000).as_deref() != Ok("true")
    {
        return Ok(json!({"branches":[],"repoPath":repo,"isGitRepo":false}));
    }
    if !supports_native_projection(repo) {
        return Err(());
    }
    let default = branch_git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        2000,
    )
    .ok()
    .and_then(|name| name.strip_prefix("origin/").map(str::to_owned))
    .unwrap_or_else(|| {
        if branch_git(repo, &["rev-parse", "--verify", "master"], 2000).is_ok() {
            "master".to_owned()
        } else {
            "main".to_owned()
        }
    });
    // A range starting with '-' can become a Git option (including --output).
    // Do not execute that unsupported metadata in the native read-only path.
    // The unchanged TypeScript handler retains ownership for separate review.
    if default.starts_with('-') || default.chars().any(char::is_control) {
        return Err(());
    }
    let Ok(raw) = branch_git(
        repo,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "refs/heads/",
            "--format=%(refname:short)|||%(objectname)|||%(committerdate:relative)|||%(subject)|||%(HEAD)|||%(committerdate:unix)",
        ],
        5000,
    ) else {
        return Err(());
    };
    if raw.lines().count() > MAX_BRANCHES {
        return Err(());
    }
    let worktrees =
        branch_git(repo, &["worktree", "list", "--porcelain"], 5000).unwrap_or_default();
    let mut roots = HashMap::new();
    let mut current = "";
    for line in worktrees.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = path;
        }
        if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            roots.insert(branch, current);
        }
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut branches = Vec::new();
    for line in raw.lines().filter(|line| !line.is_empty()) {
        if cancelled() {
            return Err(());
        }
        let fields: Vec<_> = line.split("|||").collect();
        let field = |index| fields.get(index).copied().unwrap_or("").trim();
        let name = field(0);
        if name.is_empty() {
            continue;
        }
        let current = field(4) == "*";
        let worktree = roots.get(name).copied().filter(|path| *path != repo);
        if (!current && worktree.is_none() && name.starts_with("worktree/"))
            || name.starts_with("worktree-agent-")
            || (!current && worktree.is_some_and(|path| path.contains("/.claude/worktrees/agent-")))
        {
            continue;
        }
        if !current
            && worktree.is_none()
            && name != default
            && branch_git(
                repo,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--quiet",
                    &format!("{default}..{name}"),
                ],
                3000,
            )
            .is_ok()
        {
            continue;
        }
        let counts = branch_git(
            repo,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("origin/{name}...{name}"),
            ],
            3000,
        )
        .unwrap_or_default();
        let mut counts = counts
            .split('\t')
            .map(|part| part.parse::<i64>().unwrap_or(0));
        let behind = counts.next().unwrap_or(0);
        let ahead = counts.next().unwrap_or(0);
        let (additions, deletions) = if name == default {
            (0, 0)
        } else {
            shortstat(
                &branch_git(
                    repo,
                    &[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--shortstat",
                        &format!("{default}...{name}"),
                    ],
                    3000,
                )
                .unwrap_or_default(),
            )
        };
        let timestamp = field(5)
            .parse::<i64>()
            .ok()
            .map(|value| value.saturating_mul(1000));
        let days = timestamp.map(|timestamp| (now - timestamp).div_euclid(86_400_000));
        let stale = !current && days.is_some_and(|days| days >= 3);
        let mut branch = json!({"name":name,"current":current,"lastCommitAge":field(2),
            "lastCommitMessage":field(3),"lastCommitUnix":timestamp,"isWorktree":worktree.is_some(),
            "ahead":ahead,"behind":behind,"additions":additions,"deletions":deletions,"isStale":stale});
        if stale {
            branch["staleDays"] = json!(days);
        }
        if let Some(path) = worktree {
            branch["worktreePath"] = json!(path);
            if let Ok(size) = command("du", &["-sh", path], 3000, 1024 * 1024) {
                if let Some(size) = size
                    .trim()
                    .split('\t')
                    .next()
                    .filter(|size| !size.is_empty())
                {
                    branch["diskSize"] = json!(size);
                }
            }
        }
        branches.push(branch);
    }
    branches.sort_by(
        |a, b| match (a["lastCommitUnix"].as_i64(), b["lastCommitUnix"].as_i64()) {
            (Some(a), Some(b)) => b.cmp(&a),
            _ => std::cmp::Ordering::Equal,
        },
    );
    if cancelled() {
        return Err(());
    }
    Ok(json!({"branches":branches,"repoPath":repo}))
}

fn refresh(repo: String, previous: String) {
    let result = projection_lock().try_lock().ok().and_then(|_guard| {
        let _deadline = Deadline::start();
        if !supports_native_projection(&repo) {
            return None;
        }
        let next = generation(&repo)?;
        if next == previous {
            return None;
        }
        Some((next, compute_branches(&repo, true).ok()?))
    });
    let mut cache = snapshots()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(snapshot) = cache.entries.get_mut(&repo) {
        snapshot.refreshing = false;
        if let Some((generation, body)) = result {
            snapshot.generation = generation;
            snapshot.body = body;
        }
    }
}

fn branches(params: &Params) -> Response {
    let repo = value(params, "path");
    if repo.is_empty() {
        return response(
            StatusCode::BAD_REQUEST,
            json!({"error":"path parameter required"}),
        );
    }
    let cached = {
        let mut cache = snapshots()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cache.clock += 1;
        let used = cache.clock;
        cache.entries.get_mut(repo).map(|snapshot| {
            snapshot.used = used;
            let refresh = (!snapshot.refreshing).then(|| snapshot.generation.clone());
            snapshot.refreshing = true;
            (snapshot.body.clone(), refresh)
        })
    };
    if let Some((body, refresh_generation)) = cached {
        if let Some(previous) = refresh_generation {
            let repo = repo.to_owned();
            tokio::task::spawn_blocking(move || refresh(repo, previous));
        }
        return response(StatusCode::OK, body);
    }
    let Ok(_guard) = projection_lock().try_lock() else {
        return unavailable();
    };
    let _deadline = Deadline::start();
    let generation = generation(repo);
    let Ok(body) = compute_branches(repo, generation.is_some()) else {
        return unavailable();
    };
    if cancelled() {
        return unavailable();
    }
    if let Some(generation) = generation {
        let mut cache = snapshots()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if cache.entries.len() >= 32 {
            if let Some(oldest) = cache
                .entries
                .iter()
                .min_by_key(|(_, value)| value.used)
                .map(|(key, _)| key.clone())
            {
                cache.entries.remove(&oldest);
            }
        }
        cache.clock += 1;
        let used = cache.clock;
        cache.entries.insert(
            repo.to_owned(),
            Snapshot {
                generation,
                body: body.clone(),
                used,
                refreshing: false,
            },
        );
    }
    response(StatusCode::OK, body)
}

pub(super) fn read(path: &str, params: &Params) -> Response {
    match path {
        "/api/panel/branches" => branches(params),
        _ => unavailable(),
    }
}
