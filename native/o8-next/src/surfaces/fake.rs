//! Test-only port: this file and one registration line are the entire extension.
use super::*;
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct Slice {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub probe_visits: usize,
}
fn is_zero(value: &usize) -> bool {
    *value == 0
}
#[derive(Default)]
pub(super) struct Runtime {
    pub opens: usize,
}
pub(super) struct View {
    focus: FocusHandle,
    receipt: Result<serde_json::Value, String>,
}
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((8, || Command::Fake)),
    key_down: |shell, event, window, cx| {
        if event.keystroke == gpui::Keystroke::parse("ctrl-alt-f10").unwrap() {
            shell.execute(Command::Fake, window, cx);
            true
        } else {
            false
        }
    },
    create: |shell, _, workspace, _, cx| {
        shell
            .state
            .workspaces
            .get_mut(&workspace)
            .unwrap()
            .surfaces
            .fake
            .probe_visits += 1;
        let receipt = shell.client.fake_request();
        Some(Content::Fake(cx.new(|cx| View {
            focus: cx.focus_handle(),
            receipt,
        })))
    },
    nav: |_, position, cx| {
        if position != NavPosition::AfterWorkspaces {
            return vec![];
        }
        vec![
            div()
                .id("registration-probe-nav")
                .debug_selector(|| "registration-probe-nav".into())
                .child("Probe")
                .on_click(cx.listener(|s, _, window, cx| s.execute(Command::Fake, window, cx)))
                .into_any_element(),
        ]
    },
    ..Registration::new("Probe", "Open registration probe", |shell, _, _, _| {
        shell.surfaces.fake.opens += 1;
        Some((Tab::Fake, false))
    })
};
impl Render for View {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .track_focus(&self.focus)
            .key_context("Probe List")
            .debug_selector(|| "registration-probe-view".into())
            .child("Registration probe")
    }
}
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
    }
    fn ready(_: &Entity<Self>, _: &App) -> bool {
        true
    }
}

// This inherent method is loaded by the same single shell registration entry.
impl Client {
    fn fake_request(&self) -> Result<serde_json::Value, String> {
        let mut url = self
            .url("/api/panel/registration-probe")
            .map_err(|_| "Invalid probe route")?;
        url.query_pairs_mut().append_pair("surface", "fake");
        let response = self
            .request("POST", &url)
            .send_json(serde_json::json!({"probe":"native request"}))
            .map_err(|error| match error {
                ureq::Error::Status(status, _) => format!("Probe HTTP {status}"),
                _ => "Probe transport failed".into(),
            })?;
        Self::read(response)
    }
}

#[gpui::test]
fn new_surface_routes_renders_and_gets_navigation(cx: &mut gpui::TestAppContext) {
    use crate::shell::test_support::*;
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("fake.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let before =
        serde_json::to_value(State::load(&fixture.root.join("fake.json")).unwrap()).unwrap();
    for workspace in before["workspaces"].as_object().unwrap().values() {
        let keys = workspace
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            ["tabs", "active", "composer", "selections"]
                .into_iter()
                .collect(),
            "existing workspace JSON shape"
        );
    }
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("p r o b e");
    assert_eq!(
        shell.read_with(&visual, |s, _| s
            .commands()
            .iter()
            .map(|c| c.label(&s.sessions))
            .collect::<Vec<_>>()),
        vec!["Open registration probe"]
    );
    visual.simulate_keystrokes("enter");
    draw(&mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active().unwrap().label()),
        "Probe"
    );
    assert!(visual.debug_bounds("registration-probe-view").is_some());
    shell.read_with(&visual, |s, cx| {
        let Content::Fake(view) = s.content.get(&s.key(&Tab::Fake)).unwrap() else {
            panic!("fake surface");
        };
        assert_eq!(
            view.read(cx).receipt.as_ref().unwrap(),
            &serde_json::json!({
                "surface":"fake", "payload":"native request", "request":1, "desktopSession":false,
            }),
            "the real shell must create its view using the module-owned authenticated request"
        );
    });
    assert_eq!(
        fixture
            .client
            .clone()
            .with_desktop_session(Some("fixture-probe-account".into()))
            .unwrap()
            .fake_request()
            .unwrap()["desktopSession"],
        false,
        "ordinary surface requests must not forward desktop account identity implicitly"
    );
    let refused =
        Client::authenticated(&fixture.origin, Some("fixture-invalid-probe".into())).unwrap();
    assert_eq!(refused.fake_request().unwrap_err(), "Probe HTTP 401");
    let nav = visual
        .debug_bounds("registration-probe-nav")
        .expect("module nav entry");
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    visual.simulate_click(nav.center(), gpui::Modifiers::default());
    draw(&mut visual);
    assert_eq!(shell.read_with(&visual, |s, _| s.active()), Some(Tab::Fake));
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    assert_ne!(shell.read_with(&visual, |s, _| s.active()), Some(Tab::Fake));
    visual.simulate_keystrokes("ctrl-alt-j");
    draw(&mut visual);
    assert_eq!(shell.read_with(&visual, |s, _| s.active()), Some(Tab::Fake));
    assert_eq!(shell.read_with(&visual, |s, _| s.surfaces.fake.opens), 3);
    let saved = State::load(&fixture.root.join("fake.json")).unwrap();
    assert!(
        saved
            .workspaces
            .values()
            .any(|w| w.tabs.contains(&Tab::Fake) && w.surfaces.fake.probe_visits == 3)
    );
}

#[gpui::test]
fn review_registered_raw_hook_composes_and_respects_focus(cx: &mut gpui::TestAppContext) {
    use crate::shell::test_support::*;
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("hook.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-alt-f10");
    draw(&mut visual);
    assert_eq!(shell.read_with(&visual, |s, _| s.active()), Some(Tab::Fake));
    visual.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-alt-f10");
    assert!(
        matches!(
            shell.read_with(&visual, |s, _| s.active()),
            Some(Tab::Session(_))
        ),
        "legacy hooks cannot preempt a field"
    );
}

#[path = "fake/parity_tests.rs"]
mod parity_tests;
