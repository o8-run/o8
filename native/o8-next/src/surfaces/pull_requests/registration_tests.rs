//! Compile the real application with and without its single PR registration.
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn check(source: &Path, target: &Path) -> Output {
    Command::new(env!("CARGO"))
        .args([
            "check",
            "--locked",
            "--offline",
            "--bin",
            "o8-next",
            "--manifest-path",
        ])
        .arg(source.join("Cargo.toml"))
        .env("CARGO_TARGET_DIR", target)
        .output()
        .unwrap()
}

#[test]
fn pull_requests_without_operator_credential_refuse_before_delivery() {
    let client = crate::client::Client::authenticated("http://127.0.0.1:1", None).unwrap();
    assert_eq!(
        client.pr_post("/api/panel/prs/7", &serde_json::json!({"action":"comment"})),
        Err("An operator credential is required".into())
    );
}

#[test]
fn pull_requests_single_registration_owns_the_request_adapter() {
    let original = Path::new(env!("CARGO_MANIFEST_DIR"));
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| original.join("target"));
    let scratch = Scratch(target.join(format!(
        "pull-request-registration-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    )));
    fs::create_dir_all(&scratch.0).unwrap();
    copy_tree(&original.join("src"), &scratch.0.join("src"));
    copy_tree(&original.join("fixtures"), &scratch.0.join("fixtures"));
    fs::copy(original.join("Cargo.lock"), scratch.0.join("Cargo.lock")).unwrap();
    // Keep the exact dependency graph and the original immutable vendor source.
    // Only the temporary manifest's relative vendor path needs relocation.
    let manifest = fs::read_to_string(original.join("Cargo.toml")).unwrap();
    let vendor = serde_json::to_string(&original.join("vendor/taffy")).unwrap();
    assert!(manifest.contains("path = \"vendor/taffy\""));
    fs::write(
        scratch.0.join("Cargo.toml"),
        manifest.replacen("path = \"vendor/taffy\"", &format!("path = {vendor}"), 1),
    )
    .unwrap();
    // Separate from the outer cargo-test target lock; retain dependency metadata
    // within CARGO_TARGET_DIR for subsequent red/green/full runs.
    let check_target = target.join("pull-request-registration-target");
    let main_path = scratch.0.join("src/main.rs");
    let main = fs::read_to_string(&main_path).unwrap();
    let probe = r#"
fn pr_registration_compile_probe(client: &crate::client::Client) {
    let _ = client.pr_preview("registration-probe");
    let _ = client.pr_post("/api/panel/prs/7", &serde_json::json!({"action":"comment"}));
}
"#;
    fs::write(&main_path, format!("{main}\n{probe}")).unwrap();
    let registered = check(&scratch.0, &check_target);
    assert!(
        registered.status.success(),
        "Registered PR requests must compile: {}",
        String::from_utf8_lossy(&registered.stderr)
    );
    println!("registered real entry point: PR preview and POST compile");

    let shell_path = scratch.0.join("src/shell.rs");
    let shell = fs::read_to_string(&shell_path).unwrap();
    let registration = "        pull_requests: PullRequests = \"surfaces/pull_requests.rs\";\n";
    assert_eq!(shell.matches(registration).count(), 1);
    fs::write(&shell_path, shell.replacen(registration, "", 1)).unwrap();
    fs::write(&main_path, &main).unwrap();
    let removed = check(&scratch.0, &check_target);
    assert!(
        removed.status.success(),
        "Removing just the PR registration must compile: {}",
        String::from_utf8_lossy(&removed.stderr)
    );
    println!("removed single registration: real application still compiles");

    fs::write(&main_path, format!("{main}\n{probe}")).unwrap();
    let unavailable = check(&scratch.0, &check_target);
    assert!(
        !unavailable.status.success(),
        "Removing the PR registration must remove its request adapter; both PR methods still compile"
    );
    let errors = String::from_utf8_lossy(&unavailable.stderr);
    for method in ["pr_preview", "pr_post"] {
        assert!(
            errors.contains("error[E0599]")
                && errors.contains(&format!("no method named `{method}`")),
            "Expected the removed method {method} to be unavailable: {errors}"
        );
    }
    println!("removed single registration: pr_preview and pr_post are both unavailable (E0599)");
}
