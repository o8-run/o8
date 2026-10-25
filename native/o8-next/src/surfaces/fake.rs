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
}
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((8, || Command::Fake)),
    create: |shell, _, workspace, _, cx| {
        shell
            .state
            .workspaces
            .get_mut(&workspace)
            .unwrap()
            .surfaces
            .fake
            .probe_visits += 1;
        Some(Content::Fake(cx.new(|cx| View {
            focus: cx.focus_handle(),
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
    key_down: |s, event, window, cx| {
        if event.keystroke.modifiers.control
            && event.keystroke.modifiers.alt
            && event.keystroke.key == "j"
        {
            s.execute(Command::Fake, window, cx);
            true
        } else {
            false
        }
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
