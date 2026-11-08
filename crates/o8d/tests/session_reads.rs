#![cfg(all(unix, feature = "experimental-session-reads"))]

use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Fixture {
    directory: PathBuf,
    daemon: Option<Child>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(daemon) = &mut self.daemon {
            let _ = daemon.kill();
            let _ = daemon.wait();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn git(repo: &Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .args(["-c", "core.hooksPath=/dev/null"])
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .unwrap()
            .success()
    );
}
fn database(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
        CREATE TABLE workspace_snapshots(state TEXT);
        CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT);",
    )
    .unwrap();
    db
}

async fn read(client: &reqwest::Client, origin: &str, query: &str) -> Vec<Value> {
    let response = client
        .get(format!("{origin}/api/mobile/orchestrator/threads?{query}"))
        .bearer_auth("session-read-fixture-token")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.unwrap()["threads"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn sidebar_batches_repository_reads_and_reopens_live_state_per_request() {
    let directory =
        std::env::temp_dir().join(format!("o8d-session-reads-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(directory.join("chat-history")).unwrap();
    let mut fixture = Fixture {
        directory: directory.clone(),
        daemon: None,
    };
    let repo = directory.join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "--quiet"]);
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/first"]);
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/first.git",
        ],
    );
    for index in 0..20 {
        std::fs::write(
            directory
                .join("chat-history")
                .join(format!("thoughts-{index:02}.json")),
            serde_json::to_vec(&json!({"title":format!("Thread {index}"),"repoPath":repo,
                "backend":"claude","messages":[],"savedAt":"2026-10-01T00:00:00.000Z",
                "remoteUrl":format!("https://github.com/saved/repo-{index}.git")}))
            .unwrap(),
        )
        .unwrap();
    }
    let db_path = directory.join("cortex-ide.db");
    let db = database(&db_path);
    let key = format!(
        "inbox:subject:{}",
        json!(["conversation", repo, "thoughts-00"])
    );
    db.execute(
        "INSERT INTO app_state VALUES (?, ?)",
        [&key, "{\"inboxRevision\":1}"],
    )
    .unwrap();
    std::fs::write(directory.join("ws-token"), "session-read-fixture-token").unwrap();

    // Count real Git executions through the actual HTTP binary, without changing
    // the parent process environment or mocking the projection under test.
    let bin = directory.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let real_git = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    assert!(real_git.status.success());
    let wrapper = bin.join("git");
    std::fs::write(&wrapper, "#!/bin/sh\nprintf 'git\\n' >> \"$O8D_TEST_GIT_CALLS\"\nexec \"$O8D_TEST_REAL_GIT\" \"$@\"\n").unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let calls = directory.join("git-calls");
    let mut paths = vec![bin];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_o8d"))
        .args([
            "--experimental-http",
            "--listen",
            "127.0.0.1:0",
            "--data-dir",
        ])
        .arg(&directory)
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env(
            "O8D_TEST_REAL_GIT",
            String::from_utf8(real_git.stdout).unwrap().trim(),
        )
        .env("O8D_TEST_GIT_CALLS", &calls)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = daemon.stdout.take().unwrap();
    fixture.daemon = Some(daemon);
    let mut ready = String::new();
    BufReader::new(stdout).read_line(&mut ready).unwrap();
    let ready: Value = serde_json::from_str(&ready).unwrap();
    let origin = format!("http://{}", ready["listening"].as_str().unwrap());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let first = read(&client, &origin, "limit=500").await;
    assert_eq!(first.len(), 20);
    assert!(
        first
            .iter()
            .all(|thread| thread["githubRepo"] == "first" && thread["branch"] == "first")
    );
    assert_eq!(first[0]["inboxRevision"], 1);
    assert_eq!(
        std::fs::read_to_string(&calls).unwrap().lines().count(),
        1,
        "one repository lookup per request, regardless of the number of threads"
    );

    assert!(
        first
            .iter()
            .all(|thread| thread["isWorktree"] == false && thread["worktreePath"].is_null())
    );

    git(
        &repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/fixture/second.git",
        ],
    );
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/second"]);
    db.execute(
        "UPDATE app_state SET value = '{\"inboxRevision\":2}' WHERE key = ?",
        [&key],
    )
    .unwrap();
    let second = read(&client, &origin, "limit=500").await;
    assert!(
        second
            .iter()
            .all(|thread| thread["githubRepo"] == "second" && thread["branch"] == "second")
    );
    assert_eq!(
        second[0]["inboxRevision"], 2,
        "committed WAL update must be visible"
    );
    assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 2);

    // A request-local connection must also notice an atomic database replacement.
    db.close().unwrap();
    let replacement = directory.join("replacement.db");
    let next = database(&replacement);
    next.execute(
        "INSERT INTO app_state VALUES (?, ?)",
        [&key, "{\"inboxRevision\":3}"],
    )
    .unwrap();
    next.close().unwrap();
    std::fs::rename(replacement, &db_path).unwrap();
    git(&repo, &["remote", "remove", "origin"]);
    let third = read(&client, &origin, "limit=500").await;
    assert_eq!(third[0]["inboxRevision"], 3);
    for (index, thread) in third.iter().enumerate() {
        assert_eq!(
            thread["githubRepo"],
            format!("repo-{index}"),
            "saved URL fallback belongs to each record"
        );
    }
    assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 3);

    let other = directory.join("other-repo");
    std::fs::create_dir(&other).unwrap();
    git(&other, &["init", "--quiet"]);
    let extra = directory.join("chat-history/thoughts-off-page.json");
    std::fs::write(
        &extra,
        serde_json::to_vec(&json!({"repoPath":other,
        "backend":"claude","messages":[],"savedAt":"2026-09-01T00:00:00.000Z"}))
        .unwrap(),
    )
    .unwrap();
    let page = read(&client, &origin, "limit=1").await;
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["id"], "thoughts-00");
    assert_eq!(
        std::fs::read_to_string(&calls).unwrap().lines().count(),
        4,
        "a different repository outside the selected page must not trigger Git"
    );
    assert!(read(&client, &origin, "offset=21&limit=1").await.is_empty());
    assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 4);

    // The additive checkout fields must identify the linked root even when a
    // session's cwd is nested below it, and not inherit it from a deleted cwd.
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
    std::fs::write(
        &extra,
        serde_json::to_vec(&json!({"repoPath":nested,
        "backend":"claude","messages":[],"savedAt":"2026-10-02T00:00:00.000Z"}))
        .unwrap(),
    )
    .unwrap();
    let page = read(&client, &origin, "limit=1").await;
    assert_eq!(page[0]["isWorktree"], true);
    assert_eq!(page[0]["worktreePath"], json!(linked));
    assert_eq!(page[0]["branch"], "linked");
    let invalid_git = nested.join(".git");
    std::fs::write(&invalid_git, "invalid checkout pointer\n").unwrap();
    let invalid = read(&client, &origin, "limit=1").await;
    assert_eq!(invalid[0]["isWorktree"], false);
    assert!(invalid[0]["worktreePath"].is_null());
    assert!(invalid[0]["branch"].is_null());
    assert_eq!(invalid[0]["repoSlug"], "nested");
    std::fs::remove_file(invalid_git).unwrap();
    std::fs::remove_dir(nested).unwrap();
    let deleted = read(&client, &origin, "limit=1").await;
    assert_eq!(deleted[0]["isWorktree"], false);
    assert!(deleted[0]["worktreePath"].is_null());
    assert!(deleted[0]["branch"].is_null());

    // The TS sidebar treats a directory marker as the main checkout, even if
    // an unrelated commondir file is present. Only gitfile pointers use it.
    std::fs::write(repo.join(".git/commondir"), "../unrelated").unwrap();
    std::fs::write(
        &extra,
        serde_json::to_vec(&json!({"repoPath":repo,
        "backend":"claude","messages":[],"savedAt":"2026-10-02T00:00:00.000Z"}))
        .unwrap(),
    )
    .unwrap();
    let main = read(&client, &origin, "limit=1").await;
    assert_eq!(main[0]["isWorktree"], false);
    assert!(main[0]["worktreePath"].is_null());
    assert_eq!(main[0]["branch"], "second");
}

fn thread_title(directory: &Path, title: &str) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"title":title,"repoPath":directory.join("repo"),"backend":"claude",
        "messages":[],"savedAt":"2026-10-01T00:00:00.000Z"}),
    )
    .unwrap()
}

#[tokio::test]
async fn sidebar_summaries_are_reread_when_a_save_replaces_the_file() {
    let directory =
        std::env::temp_dir().join(format!("o8d-thread-summaries-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(directory.join("chat-history")).unwrap();
    std::fs::create_dir(directory.join("repo")).unwrap();
    let mut fixture = Fixture {
        directory: directory.clone(),
        daemon: None,
    };
    let file = directory.join("chat-history/thoughts-summary.json");
    std::fs::write(&file, thread_title(&directory, "Alpha")).unwrap();
    let _db = database(&directory.join("cortex-ide.db"));
    std::fs::write(directory.join("ws-token"), "session-read-fixture-token").unwrap();
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_o8d"))
        .args([
            "--experimental-http",
            "--listen",
            "127.0.0.1:0",
            "--data-dir",
        ])
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = daemon.stdout.take().unwrap();
    fixture.daemon = Some(daemon);
    let mut ready = String::new();
    BufReader::new(stdout).read_line(&mut ready).unwrap();
    let ready: Value = serde_json::from_str(&ready).unwrap();
    let origin = format!("http://{}", ready["listening"].as_str().unwrap());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let title = |threads: Vec<Value>| threads[0]["title"].as_str().unwrap().to_owned();
    assert_eq!(title(read(&client, &origin, "").await), "Alpha");

    // Rewritten in place with the same inode, size and mtime: the summary is
    // served from the cache, as the TS cache does. Saves never write this way.
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    let same_file = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
    std::io::Write::write_all(&mut &same_file, &thread_title(&directory, "Bravo")).unwrap();
    same_file.set_modified(modified).unwrap();
    drop(same_file);
    assert_eq!(title(read(&client, &origin, "").await), "Alpha");

    // A save writes a temporary file and renames it: a new inode, read again
    // even with the same size and mtime.
    let temporary = directory.join("chat-history/thoughts-summary.json.tmp");
    std::fs::write(&temporary, thread_title(&directory, "Carol")).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&temporary)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    std::fs::rename(&temporary, &file).unwrap();
    let after = std::fs::metadata(&file).unwrap();
    assert_eq!(after.len(), thread_title(&directory, "Alpha").len() as u64);
    assert_eq!(after.modified().unwrap(), modified);
    assert_eq!(title(read(&client, &origin, "").await), "Carol");
}
