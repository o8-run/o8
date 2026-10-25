use super::*;
pub(super) struct Fixture(crate::shell::test_support::Fixture);
impl std::ops::DerefMut for Fixture {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl std::ops::Deref for Fixture {
    type Target = crate::shell::test_support::Fixture;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Fixture {
    pub(super) fn wait_approval_ready(&self) {
        let mut url = self
            .client
            .url("/api/orchestrator/inline-fixture-ready")
            .unwrap();
        url.query_pairs_mut().append_pair("phase", "approval");
        let receipt = self
            .client
            .request("GET", &url)
            .timeout(std::time::Duration::from_secs(180))
            .call()
            .unwrap_or_else(|error| panic!("held fixture readiness: {error}"))
            .into_json::<Value>()
            .unwrap();
        assert_eq!(receipt["ready"], true, "held fixture readiness: {receipt}");
    }
    pub(super) fn new() -> Self {
        Self::start_mode(false, "")
    }
    pub(super) fn start_mode(projects: bool, option: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-inline-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut command = Process::new("node");
        command.args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/surfaces/inline-host-fixture.ts",
        ]);
        if projects {
            command.arg("--projects");
        } else {
            command.args(["--composer", "--shell"]);
        }
        command.arg("--inline").args(option.split_whitespace());
        let mut server = command
            .current_dir(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .env(
                "O8_NEXT_BRAIN_REQUEST_LOG",
                root.join("brain-requests.json"),
            )
            .env("O8_NEXT_API_TOKEN", "fixture-shell-bearer")
            .stdout(Stdio::piped())
            .stderr(Stdio::from(
                fs::File::create(root.join("fixture.log")).unwrap(),
            ))
            .spawn()
            .unwrap();
        let mut output = BufReader::new(server.stdout.take().unwrap()).lines();
        let receipt = output
            .by_ref()
            .find_map(|line| {
                let data = serde_json::from_str::<Value>(&line.ok()?).ok()?;
                data["origin"].as_str()?;
                Some(data)
            })
            .unwrap_or_else(|| {
                panic!(
                    "inline fixture readiness: {}",
                    fs::read_to_string(root.join("fixture.log")).unwrap_or_default()
                )
            });
        std::thread::spawn(move || for _ in output {});
        Self(crate::shell::test_support::Fixture {
            server,
            client: Client::authenticated(
                receipt["origin"].as_str().unwrap(),
                Some("fixture-shell-bearer".into()),
            )
            .unwrap(),
            root,
            folders: receipt["folders"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect(),
            origin: receipt["origin"].as_str().unwrap().to_owned(),
        })
    }
    pub(super) fn mode(brain: bool, settings: bool, committed: bool) -> Self {
        let mut args = Vec::new();
        if brain {
            args.push("--brain");
        }
        if settings {
            args.push("--settings");
        }
        if committed {
            args.push("--inline-committed");
        }
        Self::start_mode(false, &args.join(" "))
    }
}
