#![cfg(all(unix, feature = "experimental-session-reads"))]

use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const TOKEN: &str = "repository-read-fixture-token";
struct Fixture {
    directory: PathBuf,
    daemon: Option<Child>,
    origin: String,
}
impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("o8d-repository-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("ws-token"), TOKEN).unwrap();
        Self {
            directory,
            daemon: None,
            origin: String::new(),
        }
    }
    fn start(&mut self, enabled: bool, wrapper: Option<&Path>) {
        let mut command = Command::new(env!("CARGO_BIN_EXE_o8d"));
        command
            .args([
                "--experimental-http",
                "--listen",
                "127.0.0.1:0",
                "--data-dir",
            ])
            .arg(&self.directory)
            .arg("--exit-on-stdin-eof")
            .env(
                "O8D_NATIVE_REPOSITORY_READS",
                if enabled { "1" } else { "0" },
            )
            .env_remove("GIT_EXTERNAL_DIFF")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(wrapper) = wrapper {
            let mut paths = vec![wrapper.to_owned()];
            paths.extend(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ));
            command.env("PATH", std::env::join_paths(paths).unwrap());
            command.env("O8D_TEST_CHILD_PID", self.directory.join("child-pid"));
        }
        let mut daemon = command.spawn().unwrap();
        let stdout = daemon.stdout.take().unwrap();
        self.daemon = Some(daemon);
        let mut ready = String::new();
        BufReader::new(stdout).read_line(&mut ready).unwrap();
        let ready: Value = serde_json::from_str(&ready).unwrap();
        self.origin = format!("http://{}", ready["listening"].as_str().unwrap());
    }
    async fn get(&self, repo: Option<&Path>) -> reqwest::Response {
        let mut request = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("{}/api/panel/branches", self.origin))
            .bearer_auth(TOKEN)
            .timeout(Duration::from_secs(10));
        if let Some(repo) = repo {
            request = request.query(&[("path", repo.to_str().unwrap())]);
        }
        request.send().await.unwrap()
    }
    async fn close_stdin(&mut self) {
        let daemon = self.daemon.as_mut().unwrap();
        drop(daemon.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = daemon.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(
                Instant::now() < deadline,
                "reader did not exit after parent EOF"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
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
    let output = Command::new("git")
        .args(["-c", "core.hooksPath=/dev/null", "-C"])
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn repository(directory: &Path, name: &str) -> PathBuf {
    let repo = directory.join(name);
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "--quiet", "--initial-branch=main"]);
    std::fs::write(repo.join("tracked.txt"), "main\n").unwrap();
    git(&repo, &["add", "tracked.txt"]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--no-gpg-sign",
            "--quiet",
            "-m",
            "initial",
        ],
    );
    repo
}

#[tokio::test]
async fn flag_defaults_to_existing_unknown_route_and_parent_eof_stops_idle_reader() {
    let mut fixture = Fixture::new();
    fixture.start(false, None);
    let response = fixture.get(None).await;
    assert_eq!(response.status(), 404);
    assert!(
        response
            .headers()
            .get("x-o8d-native-repository-read")
            .is_none()
    );
    fixture.close_stdin().await;
}

#[tokio::test]
async fn native_reader_defers_helper_promisor_and_option_like_metadata_without_writes() {
    let mut fixture = Fixture::new();
    fixture.start(true, None);
    let response = fixture.get(None).await;
    assert_eq!(response.status(), 400);
    assert_eq!(response.headers()["x-o8d-native-repository-read"], "1");
    for (index, key) in [
        "diff.external",
        "diff.fixture.textconv",
        "diff.fixture.command",
        "remote.origin.promisor",
        "extensions.partialclone",
    ]
    .iter()
    .enumerate()
    {
        let repo = repository(&fixture.directory, &format!("config-{index}"));
        let marker = fixture.directory.join(format!("helper-ran-{index}"));
        let helper = fixture.directory.join(format!("helper-{index}"));
        std::fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let value = if key.ends_with("promisor") {
            "true"
        } else if key.ends_with("partialclone") {
            "origin"
        } else {
            helper.to_str().unwrap()
        };
        // Includes must be evaluated, not just the repository's literal config.
        let include = fixture.directory.join(format!("included-config-{index}"));
        git(
            &repo,
            &["config", "--file", include.to_str().unwrap(), key, value],
        );
        git(
            &repo,
            &["config", "include.path", include.to_str().unwrap()],
        );
        let response = fixture.get(Some(&repo)).await;
        assert_eq!(response.status(), 503, "unsupported config {key}");
        assert!(
            response
                .headers()
                .get("x-o8d-native-repository-read")
                .is_none()
        );
        assert!(!marker.exists(), "helper must not execute");
    }
    let repo = repository(&fixture.directory, "option-default");
    git(&repo, &["branch", "feature"]);
    let output = fixture.directory.join("unexpected-output");
    git(
        &repo,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            &format!("refs/remotes/origin/--output={}", output.display()),
        ],
    );
    assert_eq!(fixture.get(Some(&repo)).await.status(), 503);
    assert!(!PathBuf::from(format!("{}...feature", output.display())).exists());
    fixture.close_stdin().await;
}

#[tokio::test]
async fn committed_branch_changes_refresh_the_bounded_snapshot() {
    let mut fixture = Fixture::new();
    let repo = repository(&fixture.directory, "repo");
    fixture.start(true, None);
    let first = fixture
        .get(Some(&repo))
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(first["branches"].as_array().unwrap().len(), 1);
    git(&repo, &["switch", "--quiet", "-c", "feature"]);
    std::fs::write(repo.join("tracked.txt"), "feature\n").unwrap();
    git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--no-gpg-sign",
            "--quiet",
            "-am",
            "feature",
        ],
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = fixture.get(Some(&repo)).await;
        assert_eq!(response.headers()["x-o8d-native-repository-read"], "1");
        let body = response.json::<Value>().await.unwrap();
        if body["branches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|branch| branch["name"] == "feature" && branch["current"] == true)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "snapshot did not observe committed ref change"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    fixture.close_stdin().await;
}

#[tokio::test]
async fn parent_eof_cancels_active_git_and_reaps_it_before_exit() {
    let mut fixture = Fixture::new();
    let bin = fixture.directory.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let wrapper = bin.join("git");
    std::fs::write(
        &wrapper,
        "#!/bin/sh\nprintf '%s' \"$$\" > \"$O8D_TEST_CHILD_PID\"\nexec sleep 60\n",
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    fixture.start(true, Some(&bin));
    let url = format!("{}/api/panel/branches?path=fixture", fixture.origin);
    let request = tokio::spawn(async move {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url)
            .bearer_auth(TOKEN)
            .send()
            .await
    });
    let marker = fixture.directory.join("child-pid");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !marker.exists() {
        assert!(Instant::now() < deadline, "Git child did not start");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid = std::fs::read_to_string(marker).unwrap();
    fixture.close_stdin().await;
    assert!(
        !Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success(),
        "Git child survived the owning reader"
    );
    let _ = request.await;
}
