//! The native updater through the real launcher binary: a fixture feed served
//! on a free port, archives signed with a key generated here (never the
//! release key), and an app bundle in a temporary directory.
#![cfg(target_os = "macos")]
mod support;
use base64::Engine;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use support::*;

#[derive(Clone)]
struct Reply {
    status: u16,
    body: Vec<u8>,
    truncate: bool,
}
/// A minimal HTTP/1.1 server: one response per path, every request recorded.
struct Feed {
    port: u16,
    routes: Arc<Mutex<HashMap<String, Reply>>>,
    requests: Arc<Mutex<Vec<String>>>,
}
impl Feed {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes: Arc<Mutex<HashMap<String, Reply>>> = Arc::default();
        let requests: Arc<Mutex<Vec<String>>> = Arc::default();
        let (r, q) = (routes.clone(), requests.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (r, q) = (r.clone(), q.clone());
                std::thread::spawn(move || serve(stream, &r, &q));
            }
        });
        Self {
            port,
            routes,
            requests,
        }
    }
    fn route(&self, path: &str, status: u16, body: Vec<u8>, truncate: bool) {
        self.routes.lock().unwrap().insert(
            path.into(),
            Reply {
                status,
                body,
                truncate,
            },
        );
    }
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
    fn requested(&self, path: &str) -> bool {
        self.requests.lock().unwrap().iter().any(|request| {
            request
                .lines()
                .next()
                .is_some_and(|line| line.contains(path))
        })
    }
}
fn serve(mut stream: TcpStream, routes: &Mutex<HashMap<String, Reply>>, log: &Mutex<Vec<String>>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
    log.lock().unwrap().push(head);
    let reply = routes.lock().unwrap().get(&path).cloned().unwrap_or(Reply {
        status: 404,
        body: Vec::new(),
        truncate: false,
    });
    let _ = write!(
        stream,
        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reply.status,
        reply.body.len()
    );
    let sent = if reply.truncate {
        &reply.body[..reply.body.len() / 2]
    } else {
        &reply.body[..]
    };
    let _ = stream.write_all(sent);
    let _ = stream.flush();
}

fn plist(version: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>o8</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
</dict></plist>
"#
    )
}
/// The bundle's main program records that it ran, with its version and arguments.
fn program(root: &Path, version: &str) -> String {
    format!(
        "#!/usr/bin/env python3\nimport sys,json\nopen({:?},'w').write(json.dumps({{'version':{version:?},'args':sys.argv[1:]}}))\n",
        root.join("relaunched").to_string_lossy()
    )
}

struct Keys {
    pair: minisign::KeyPair,
    public: String,
}
fn b64(text: String) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}
fn keys() -> Keys {
    let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let public = b64(pair.pk.to_box().unwrap().to_string());
    Keys { pair, public }
}
fn sign(keys: &Keys, data: &[u8]) -> String {
    b64(minisign::sign(None, &keys.pair.sk, data, None, None)
        .unwrap()
        .to_string())
}

fn header(path: &str, kind: tar::EntryType, size: usize, mode: u32) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(kind);
    header.set_size(size as u64);
    header.set_mode(mode);
    // Written raw so hostile names reach the archive unchanged.
    header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
    header.set_cksum();
    header
}
/// The classic `.app.tar.gz`: one top directory holding the bundle.
fn archive(root: &Path, version: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    archive_program(version, program(root, version).as_bytes(), extra)
}

fn archive_program(version: &str, executable: &[u8], extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut add = |path: &str, data: &[u8], mode: u32| {
        builder
            .append(
                &header(path, tar::EntryType::Regular, data.len(), mode),
                data,
            )
            .unwrap();
    };
    add(
        "o8.app/Contents/Info.plist",
        plist(version).as_bytes(),
        0o644,
    );
    add("o8.app/Contents/MacOS/o8", executable, 0o755);
    for (path, data) in extra {
        add(path, data, 0o644);
    }
    let mut link = header("o8.app/Contents/Current", tar::EntryType::Symlink, 0, 0o777);
    link.as_old_mut().linkname[..5].copy_from_slice(b"MacOS");
    link.set_cksum();
    builder.append(&link, &[][..]).unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&builder.into_inner().unwrap()).unwrap();
    gz.finish().unwrap()
}

struct Case {
    f: Fixture,
    feed: Feed,
    keys: Keys,
    bundle: PathBuf,
}
impl Case {
    fn new() -> Self {
        let f = Fixture::new();
        let feed = Feed::new();
        let keys = keys();
        let apps = f.root.join("Apps");
        let bundle = apps.join("o8.app");
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        fs::write(bundle.join("Contents/Info.plist"), plist("1.0.0")).unwrap();
        let main = bundle.join("Contents/MacOS/o8");
        fs::write(&main, program(&f.root, "1.0.0")).unwrap();
        fs::set_permissions(&main, fs::Permissions::from_mode(0o755)).unwrap();
        let path = f.root.join("config.json");
        let mut config: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        config["version"] = "1.0.0".into();
        config["update"] = serde_json::json!({
            "bundle": bundle,
            "background_delay_ms": 3_600_000,
            "settings": f.root.join("update-ping.json"),
            "endpoints": [
                feed.url("/v1/update/{{target}}/{{arch}}/{{current_version}}"),
                feed.url("/feed/latest.json"),
            ],
            "pubkey": keys.public,
        });
        fs::write(&path, config.to_string()).unwrap();
        Self {
            f,
            feed,
            keys,
            bundle,
        }
    }
    /// Publishes a manifest on the mirror for `version` pointing at `bytes`.
    fn publish(&self, version: &str, bytes: Vec<u8>, signature: String, truncate: bool) {
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x86_64"
        };
        let manifest = serde_json::json!({
            "version": version, "notes": "fixture", "pub_date": "2026-11-14T00:00:00Z",
            "channel": "stable",
            "platforms": {format!("darwin-{arch}"): {"url": self.feed.url("/o8.app.tar.gz"), "signature": signature}},
        });
        self.feed.route(
            "/feed/latest.json",
            200,
            manifest.to_string().into_bytes(),
            false,
        );
        self.feed.route("/o8.app.tar.gz", 200, bytes, truncate);
    }
    fn signed(&self, version: &str, extra: &[(&str, &[u8])]) -> (Vec<u8>, String) {
        let bytes = archive(&self.f.root, version, extra);
        let signature = sign(&self.keys, &bytes);
        (bytes, signature)
    }
    fn installed(&self) -> String {
        fs::read_to_string(self.bundle.join("Contents/Info.plist")).unwrap()
    }
    fn staging(&self) -> PathBuf {
        self.bundle.parent().unwrap().join(".o8.app.update")
    }
    fn status(&self) -> serde_json::Value {
        control(&self.f, serde_json::json!({"op":"update-status"}))
    }
    /// Applies and waits for a refusal; the launcher keeps serving throughout.
    fn refused(&mut self) -> String {
        let answer = control(&self.f, serde_json::json!({"op":"update-apply"}));
        if answer["ok"] == false {
            return answer["error"].as_str().unwrap().to_owned();
        }
        until(|| self.status()["state"] == "failed");
        assert!(self
            .f
            .launcher
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        self.status()["error"].as_str().unwrap().to_owned()
    }
    /// Nothing changed: same bundle, same servers, no staged copy, no relaunch.
    fn untouched(&self, servers: &[u32]) {
        assert!(self.installed().contains("1.0.0"));
        assert!(!self.staging().join("staged").exists());
        assert!(!self.f.root.join("relaunched").exists());
        assert_eq!(self.f.starts("api-starts"), servers);
        assert!(fs::read_dir(self.f.root.join("updates")).map_or(true, |mut d| d.next().is_none()));
    }
}

#[test]
fn good_update_installs_after_a_proven_stop_and_launches_the_new_version() {
    let mut case = Case::new();
    let (bytes, signature) = case.signed("2.0.0", &[]);
    // The service answers first for an enrolled install, as in the classic shell.
    fs::write(
        case.f.root.join("update-ping.json"),
        serde_json::json!({"installId": uuid::Uuid::new_v4().to_string(), "channel": "stable"})
            .to_string(),
    )
    .unwrap();
    let service = serde_json::json!({"version":"2.0.0","url":case.feed.url("/o8.app.tar.gz"),
        "signature":signature,"channel":"stable"});
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    case.feed.route(
        &format!("/v1/update/darwin/{arch}/1.0.0"),
        200,
        service.to_string().into_bytes(),
        false,
    );
    case.feed.route("/o8.app.tar.gz", 200, bytes, false);
    case.f.start();
    case.f.ready();
    let ports = [case.f.port("api-port"), case.f.port("ws-port")];
    let checked = control(&case.f, serde_json::json!({"op":"update-check"}));
    assert_eq!(checked["state"], "available", "{checked}");
    assert_eq!(checked["available"]["version"], "2.0.0");
    assert_eq!(checked["current"], "1.0.0");
    assert!(case
        .feed
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.to_ascii_lowercase().contains("x-o8-install-id")));
    assert_eq!(
        control(&case.f, serde_json::json!({"op":"update-apply"}))["state"],
        "staging"
    );
    let child = case.f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(
        child.wait().unwrap().success(),
        "{}",
        case.f.log("launcher-stderr")
    );
    case.f.launcher = None;
    // Work inspection and drain ran, then both servers stopped and released their ports.
    let events = fs::read_to_string(case.f.root.join("events")).unwrap();
    assert!(events.find("inspect").unwrap() < events.find("api-stop").unwrap());
    assert!(events.find("api-stop").unwrap() < events.find("ws-stop").unwrap());
    for port in ports {
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
    assert!(case.installed().contains("2.0.0"));
    until(|| case.f.root.join("relaunched").exists());
    let relaunched: serde_json::Value =
        serde_json::from_slice(&fs::read(case.f.root.join("relaunched")).unwrap()).unwrap();
    assert_eq!(relaunched["version"], "2.0.0");
    assert_eq!(
        relaunched["args"],
        serde_json::json!(["--config", case.f.root.join("config.json")])
    );
    let previous = case.staging().join("previous/o8.app/Contents/Info.plist");
    assert!(fs::read_to_string(previous).unwrap().contains("1.0.0"));
    assert!(!case.staging().join("staged").exists());
    let last: serde_json::Value =
        serde_json::from_slice(&fs::read(case.f.root.join("update-last.json")).unwrap()).unwrap();
    assert_eq!(
        (last["outcome"].as_str(), last["to"].as_str()),
        (Some("installed"), Some("2.0.0"))
    );
}

#[test]
fn bad_signature_refuses_and_changes_nothing() {
    let mut case = Case::new();
    let (bytes, _) = case.signed("2.0.0", &[]);
    let other = sign(&keys(), &bytes);
    case.publish("2.0.0", bytes, other, false);
    case.f.start();
    case.f.ready();
    let servers = case.f.starts("api-starts");
    let error = case.refused();
    assert!(error.contains("signature"), "{error}");
    case.untouched(&servers);
}

#[test]
fn truncated_download_refuses_and_changes_nothing() {
    let mut case = Case::new();
    let (bytes, signature) = case.signed("2.0.0", &[]);
    case.publish("2.0.0", bytes, signature, true);
    case.f.start();
    case.f.ready();
    let servers = case.f.starts("api-starts");
    let error = case.refused();
    assert!(error.contains("Download"), "{error}");
    case.untouched(&servers);
}

#[test]
fn signed_archive_with_a_traversal_entry_refuses() {
    let mut case = Case::new();
    let (bytes, signature) = case.signed("2.0.0", &[("o8.app/../../escaped", b"x")]);
    case.publish("2.0.0", bytes, signature, false);
    case.f.start();
    case.f.ready();
    let servers = case.f.starts("api-starts");
    let error = case.refused();
    assert!(error.contains("leaves the bundle"), "{error}");
    assert!(!case.staging().parent().unwrap().join("escaped").exists());
    assert!(!case.f.root.join("escaped").exists());
    case.untouched(&servers);
}

#[test]
fn downgrade_and_relabelled_old_archive_refuse() {
    let mut case = Case::new();
    let (bytes, signature) = case.signed("0.9.0", &[]);
    case.publish("0.9.0", bytes.clone(), signature.clone(), false);
    case.f.start();
    case.f.ready();
    let servers = case.f.starts("api-starts");
    let checked = control(&case.f, serde_json::json!({"op":"update-check"}));
    assert_eq!(checked["state"], "current", "{checked}");
    assert!(case.refused().contains("No newer update"));
    assert!(!case.feed.requested("/o8.app.tar.gz"));
    // A validly signed older archive announced as newer is still refused.
    case.publish("2.0.0", bytes, signature, false);
    let error = case.refused();
    assert!(error.contains("Archive holds version 0.9.0"), "{error}");
    case.untouched(&servers);
}

#[test]
fn unwritable_install_location_reports_and_does_nothing() {
    let mut case = Case::new();
    let (bytes, signature) = case.signed("2.0.0", &[]);
    case.publish("2.0.0", bytes, signature, false);
    let apps = case.bundle.parent().unwrap().to_path_buf();
    fs::set_permissions(&apps, fs::Permissions::from_mode(0o555)).unwrap();
    case.f.start();
    case.f.ready();
    let servers = case.f.starts("api-starts");
    let status = case.status();
    let error = case.refused();
    fs::set_permissions(&apps, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.contains("not writable"), "{error}");
    assert!(status["blocked"].as_str().unwrap().contains("not writable"));
    assert!(!case.feed.requested("/o8.app.tar.gz"));
    assert!(!case.staging().exists());
    case.untouched(&servers);
}

/// Applies with a crash injected around the swap and returns the case after the launcher died.
fn interrupted(point: &str) -> Case {
    let mut case = Case::new();
    let (bytes, signature) = case.signed("2.0.0", &[]);
    case.publish("2.0.0", bytes, signature, false);
    case.f.launcher = Some(case.f.launch_with(
        Path::new(env!("CARGO_BIN_EXE_o8-launcher")),
        &case.f.root.join("config.json"),
        &[("O8_LAUNCHER_FAULT", point)],
        "launcher-stderr",
    ));
    case.f.ready();
    control(&case.f, serde_json::json!({"op":"update-apply"}));
    let child = case.f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert_eq!(child.wait().unwrap().code(), Some(86));
    case.f.launcher = None;
    case
}
fn launchable(case: &Case, version: &str) {
    let _ = fs::remove_file(case.f.root.join("relaunched"));
    let status = std::process::Command::new(case.bundle.join("Contents/MacOS/o8"))
        .status()
        .unwrap();
    assert!(status.success());
    let ran: serde_json::Value =
        serde_json::from_slice(&fs::read(case.f.root.join("relaunched")).unwrap()).unwrap();
    assert_eq!(ran["version"], version);
    let _ = fs::remove_file(case.f.root.join("relaunched"));
}

#[test]
fn interrupted_swap_leaves_a_launchable_app_and_recovers() {
    // Crash right after the swap: the new bundle is complete and launchable.
    let mut case = interrupted("after-swap:update");
    assert!(case.installed().contains("2.0.0"));
    launchable(&case, "2.0.0");
    fs::remove_file(case.f.root.join("window-ready")).unwrap();
    case.f.start();
    case.f.ready();
    let last = &case.status()["last"];
    assert_eq!(last["outcome"], "installed", "{last}");
    assert!(!case.staging().join("staged").exists());
    assert!(
        fs::read_to_string(case.staging().join("previous/o8.app/Contents/Info.plist"))
            .unwrap()
            .contains("1.0.0")
    );
    assert!(!case.f.root.join("update-journal.json").exists());
    case.f.stop();

    // Crash right before the swap: the old bundle is untouched and launchable.
    let mut case = interrupted("before-swap:update");
    assert!(case.installed().contains("1.0.0"));
    launchable(&case, "1.0.0");
    fs::remove_file(case.f.root.join("window-ready")).unwrap();
    case.f.start();
    case.f.ready();
    let last = &case.status()["last"];
    assert_eq!(last["outcome"], "failed", "{last}");
    assert!(last["error"]
        .as_str()
        .unwrap()
        .contains("Interrupted before the swap"));
    assert!(!case.staging().join("staged").exists());
    assert!(!case.f.root.join("update-journal.json").exists());
}

#[test]
fn non_release_version_reports_unsupported_cleanly() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    for op in ["update-check", "update-apply", "update-status"] {
        let answer = control(&f, serde_json::json!({"op": op}));
        assert_eq!(answer["state"], "unsupported", "{answer}");
        assert_eq!(answer["ok"], false);
    }
    assert!(f.launcher.as_mut().unwrap().try_wait().unwrap().is_none());
}

#[test]
fn background_update_stages_without_request_and_waits_for_apply() {
    let mut case = Case::new();
    let path = case.f.root.join("config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["update"]["background_delay_ms"] = 0.into();
    fs::write(path, config.to_string()).unwrap();
    let (bytes, signature) = case.signed("2.0.0", &[]);
    case.publish("2.0.0", bytes, signature, false);
    case.f.start();
    case.f.ready();
    until(|| case.status()["state"] == "staged");
    assert!(case.feed.requested("/o8.app.tar.gz"));
    assert!(case.installed().contains("1.0.0"));
    assert!(!case.f.root.join("relaunched").exists());
    assert!(case
        .f
        .launcher
        .as_mut()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
    assert_eq!(
        control(&case.f, serde_json::json!({"op":"update-apply"}))["ok"],
        true
    );
    until(|| case.f.root.join("relaunched").exists());
    assert!(case.installed().contains("2.0.0"));
}

#[test]
fn background_bad_signature_is_discarded_while_servers_keep_running() {
    let mut case = Case::new();
    let path = case.f.root.join("config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["update"]["background_delay_ms"] = 0.into();
    fs::write(path, config.to_string()).unwrap();
    let (mut bytes, signature) = case.signed("2.0.0", &[]);
    bytes[10] ^= 1;
    case.publish("2.0.0", bytes, signature, false);
    case.f.start();
    case.f.ready();
    let servers = case.f.starts("api-starts");
    until(|| case.status()["state"] == "failed");
    assert!(case.status()["error"]
        .as_str()
        .unwrap()
        .contains("signature"));
    case.untouched(&servers);
    assert!(TcpStream::connect(("127.0.0.1", case.f.port("ws-port"))).is_ok());
}

/// Full archive compatibility, with the installed main program being this
/// branch's launcher. The helper is built in the classic updater fixture so
/// dependency resolution and installer implementation are the fixture's own.
#[test]
#[ignore = "build update-chain-classic and set O8_CLASSIC_UPDATER_FIXTURE first"]
fn classic_to_launcher_release_chain() {
    let helper = std::env::var_os("O8_CLASSIC_UPDATER_FIXTURE")
        .expect("set O8_CLASSIC_UPDATER_FIXTURE to the fixture binary");
    let launcher = fs::read(env!("CARGO_BIN_EXE_o8-launcher")).unwrap();
    for mode in [
        "good",
        "bad-signature",
        "cannot-start",
        "before-swap",
        "after-swap",
    ] {
        eprintln!("release-chain scenario: {mode}");
        let mut case = Case::new();
        fs::write(
            case.bundle.join("Contents/MacOS/o8"),
            program(&case.f.root, "0.9.0"),
        )
        .unwrap();
        fs::write(case.bundle.join("Contents/Info.plist"), plist("0.9.0")).unwrap();
        let bytes = archive_program("1.0.0", &launcher, &[]);
        let signature = sign(&case.keys, &bytes);
        case.publish("1.0.0", bytes, signature, false);
        let main = case.bundle.join("Contents/MacOS/o8");
        let _detached = DetachedLauncher(main.clone());
        let installed = std::process::Command::new(&helper)
            .arg(case.feed.url("/feed/latest.json"))
            .arg(&case.keys.public)
            .arg(&main)
            .output()
            .unwrap();
        assert!(
            installed.status.success(),
            "classic install: {}",
            String::from_utf8_lossy(&installed.stderr)
        );
        assert!(case.installed().contains("1.0.0"));
        assert!(
            fs::read(&main).unwrap() == launcher,
            "installed executable differs"
        );
        assert!(case.feed.requested("/o8.app.tar.gz"));
        let fault = format!("{mode}:update");
        let faults = [("O8_LAUNCHER_FAULT", fault.as_str())];
        case.f.launcher = Some(case.f.launch_with(
            &main,
            &case.f.root.join("config.json"),
            if mode.ends_with("swap") { &faults } else { &[] },
            "launcher-stderr",
        ));
        case.f.ready();
        assert_eq!(case.status()["current"], "1.0.0");
        let executable = if mode == "cannot-start" {
            b"#!/nonexistent-update-chain-interpreter\n".to_vec()
        } else {
            program(&case.f.root, "2.0.0").into_bytes()
        };
        let bytes = archive_program("2.0.0", &executable, &[]);
        let other = keys();
        let signature = sign(
            if mode == "bad-signature" {
                &other
            } else {
                &case.keys
            },
            &bytes,
        );
        case.publish("2.0.0", bytes, signature, false);
        if mode == "bad-signature" {
            let servers = case.f.starts("api-starts");
            assert!(case.refused().contains("signature"));
            case.untouched(&servers);
            assert!(
                fs::read(&main).unwrap() == launcher,
                "installed executable differs"
            );
            continue;
        }
        assert_eq!(
            control(&case.f, serde_json::json!({"op":"update-check"}))["available"]["version"],
            "2.0.0"
        );
        assert_eq!(
            control(&case.f, serde_json::json!({"op":"update-apply"}))["ok"],
            true
        );
        let child = case.f.launcher.as_mut().unwrap();
        until(|| child.try_wait().unwrap().is_some());
        let exit = child.wait().unwrap();
        case.f.launcher = None;
        if mode.ends_with("swap") {
            assert_eq!(exit.code(), Some(86));
            assert!(case.f.root.join("update-journal.json").exists());
            if mode == "after-swap" {
                launchable(&case, "2.0.0");
            }
            fs::remove_file(case.f.root.join("window-ready")).unwrap();
            // NEXT is an allowed stub. Recovery still runs through the real
            // launcher entry point, using the same installed-bundle override.
            if mode == "before-swap" {
                assert!(fs::read(&main).unwrap() == launcher);
                case.f.launcher = Some(case.f.launch_with(
                    &main,
                    &case.f.root.join("config.json"),
                    &[],
                    "launcher-stderr",
                ));
            } else {
                case.f.start();
            }
            case.f.ready();
            let last = &case.status()["last"];
            assert_eq!(
                last["outcome"],
                if mode == "after-swap" {
                    "installed"
                } else {
                    "failed"
                }
            );
            assert_eq!(last["from"], "1.0.0");
            assert_eq!(last["to"], "2.0.0");
            assert!(!case.f.root.join("update-journal.json").exists());
            assert!(!case.staging().join("staged").exists());
        } else if mode == "cannot-start" {
            until(|| {
                case.f.starts("api-starts").len() == 2 && case.f.root.join("launcher.sock").exists()
            });
            until(|| case.status()["last"]["outcome"] == "failed");
            assert!(case.installed().contains("1.0.0"));
            assert!(
                fs::read(&main).unwrap() == launcher,
                "installed executable differs"
            );
            assert!(case.status()["last"]["error"]
                .as_str()
                .unwrap()
                .contains("previous version was restored"));
            let server = *case.f.starts("api-starts").last().unwrap();
            let parent = std::process::Command::new("ps")
                .args(["-p", &server.to_string(), "-o", "ppid="])
                .output()
                .unwrap();
            let pid: i32 = String::from_utf8(parent.stdout)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let command = std::process::Command::new("ps")
                .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
                .output()
                .unwrap();
            assert!(String::from_utf8_lossy(&command.stdout)
                .contains(&main.to_string_lossy().to_string()));
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
            until(|| !case.f.root.join("launcher.sock").exists());
        } else {
            assert!(exit.success());
            assert!(case.installed().contains("2.0.0"));
            until(|| case.f.root.join("relaunched").exists());
            let ran: serde_json::Value =
                serde_json::from_slice(&fs::read(case.f.root.join("relaunched")).unwrap()).unwrap();
            assert_eq!(ran["version"], "2.0.0");
            assert_eq!(
                ran["args"],
                serde_json::json!(["--config", case.f.root.join("config.json")])
            );
            let last: serde_json::Value =
                serde_json::from_slice(&fs::read(case.f.root.join("update-last.json")).unwrap())
                    .unwrap();
            assert_eq!(last["outcome"], "installed");
            assert_eq!(last["from"], "1.0.0");
            assert_eq!(last["to"], "2.0.0");
        }
        if mode == "good" || mode == "after-swap" {
            let previous = case.staging().join("previous/o8.app/Contents/MacOS/o8");
            assert!(
                fs::read(previous).unwrap() == launcher,
                "previous executable differs"
            );
        }
    }
}

/// Also covers a panic after rollback starts a detached launcher. Only a
/// command inside this fixture bundle may be terminated.
struct DetachedLauncher(PathBuf);
impl Drop for DetachedLauncher {
    fn drop(&mut self) {
        let Ok(output) = std::process::Command::new("ps")
            .args(["-axww", "-o", "pid=,command="])
            .output()
        else {
            return;
        };
        let executable = self.0.to_string_lossy();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let line = line.trim();
            let Some((pid, command)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            if command
                .trim()
                .starts_with(&format!("{executable} --config "))
            {
                if let Ok(pid) = pid.parse::<i32>() {
                    unsafe {
                        libc::kill(pid, libc::SIGTERM);
                    }
                }
            }
        }
    }
}
