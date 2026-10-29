//! Keyboard target selection shared by hosted surfaces; requests stay in each port.
use super::*;
use crate::theme::current as theme;

pub(in crate::shell) struct Choice {
    pub id: String,
    pub label: String,
}
pub(in crate::shell) trait Port: 'static {
    type View: Render;
    const TITLE: &'static str;
    const EMPTY: &'static str;
    fn choices(client: &Client, workspace: &str) -> Result<Vec<Choice>, String>;
    fn create(
        client: Client,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self::View>,
    ) -> Self::View;
    fn tick(_view: &Entity<Self::View>, _cx: &mut Context<Shell>) {}
    /// The target a surface opens by itself when nothing is selected (the
    /// workspace's own shell). `None` keeps the picker.
    fn own(_client: &Client, _workspace: &str) -> Option<Result<String, String>> {
        None
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self::View>, cx: &App) -> bool;
}
pub(in crate::shell) struct Picker<P: Port> {
    client: Client,
    workspace: String,
    pub selected: Option<String>,
    pub child: Option<Entity<P::View>>,
    choices: Vec<Choice>,
    focus: FocusHandle,
    child_focus: Option<FocusHandle>,
    query: String,
    choice: usize,
    loading: bool,
    failed: bool,
    requested: Option<String>,
    // The surface's own target opens once; reopening the picker (Ctrl+Alt+O) lists.
    offered_own: bool,
    /// Why the own target could not be created; F5 and Retry try again.
    own_error: Option<String>,
    /// Each load's number; a reply from an older load is dropped.
    generation: u64,
}
impl<P: Port> Picker<P> {
    pub fn new(
        client: Client,
        workspace: String,
        selected: Option<String>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self {
            client,
            workspace,
            selected: selected.clone(),
            child: None,
            choices: vec![],
            focus: cx.focus_handle(),
            child_focus: None,
            query: String::new(),
            choice: 0,
            loading: false,
            failed: false,
            requested: selected,
            offered_own: false,
            own_error: None,
            generation: 0,
        };
        view.load(cx);
        view
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        // A newer load (Ctrl+Alt+O, F5) supersedes one in flight.
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.failed = false;
        self.own_error = None;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        // The first load always adopts the surface's own target (a terminal's owner
        // key returns the same shell every time), so a second view of the surface or
        // a saved choice the server no longer lists still opens it.
        let open = !self.offered_own;
        self.offered_own = true;
        let task = cx.background_executor().spawn(async move {
            let own = open.then(|| P::own(&client, &workspace)).flatten();
            (P::choices(&client, &workspace), own)
        });
        cx.spawn(async move |this, cx| {
            let (result, own) = task.await;
            let _ = this.update(cx, |s, cx| {
                if generation != s.generation {
                    return;
                }
                s.loading = false;
                if let Some(Err(error)) = &own {
                    s.own_error = Some(error.clone());
                    s.offered_own = false;
                }
                match result {
                    Ok(mut choices) => {
                        adopt(&mut choices, &mut s.requested, own);
                        choices.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
                        choices.dedup_by(|a, b| a.id == b.id);
                        s.choices = choices;
                    }
                    Err(_) => s.failed = true,
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn filtered(&self) -> Vec<usize> {
        let query = self.query.to_lowercase();
        self.choices
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.label.to_lowercase().contains(&query) || c.id.to_lowercase().contains(&query)
            })
            .map(|(i, _)| i)
            .collect()
    }
    fn attach(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if !self.choices.iter().any(|choice| choice.id == id) {
            self.selected = None;
            return;
        }
        let client = self.client.clone();
        self.child = Some(cx.new(|cx| P::create(client, id.clone(), window, cx)));
        self.child_focus = window.focused(cx);
        self.selected = Some(id);
        cx.notify();
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if (modifiers.control || modifiers.platform) && modifiers.alt && key == "o" {
            self.child = None;
            self.requested = None;
            self.child_focus = None;
            self.selected = None;
            self.query.clear();
            self.choice = 0;
            self.focus.focus(window);
            self.load(cx);
        } else if self.child.is_some() {
            return;
        } else if key == "f5" {
            self.load(cx);
        } else if !modifiers.control && !modifiers.platform && !modifiers.alt {
            match key {
                "up" => self.choice = self.choice.saturating_sub(1),
                "down" => {
                    self.choice = (self.choice + 1).min(self.filtered().len().saturating_sub(1))
                }
                "backspace" => {
                    self.query.pop();
                    self.choice = 0;
                }
                "escape" => {
                    self.query.clear();
                    self.choice = 0;
                }
                "enter" if !self.loading && !self.failed => {
                    if let Some(&index) = self.filtered().get(self.choice) {
                        self.attach(self.choices[index].id.clone(), window, cx);
                    }
                }
                _ => {
                    if let Some(text) = &event.keystroke.key_char {
                        self.query.push_str(text);
                        self.choice = 0;
                    }
                }
            }
        } else {
            return;
        }
        cx.notify();
        cx.stop_propagation();
    }
}
impl<P: Port> Render for Picker<P> {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.loading
            && !self.failed
            && let Some(id) = self.requested.take()
        {
            self.attach(id, window, cx);
        }
        let choices = self.filtered();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .text_size(px(13.5))
            .font_weight(gpui::FontWeight::LIGHT)
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key))
            .when_some(self.child.clone(), |view, child| view.child(child))
            .when(self.child.is_none(), |view| {
                view.child(
                    div()
                        .id("target-picker")
                        .debug_selector(|| "target-picker".into())
                        .size_full()
                        .overflow_y_scroll()
                        .p(px(16.))
                        .child(if self.query.is_empty() {
                            P::TITLE.to_string()
                        } else {
                            self.query.clone()
                        })
                        .when(self.loading, |view| view.child("Loading…"))
                        .when_some(self.own_error.clone(), |view, error| {
                            view.child(
                                div()
                                    .debug_selector(|| "target-own-error".into())
                                    .child(format!("Could not start one: {error}"))
                                    .child(
                                        div()
                                            .id("target-own-retry")
                                            .cursor_pointer()
                                            .p(px(8.))
                                            .child("Retry (F5)")
                                            .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                                    ),
                            )
                        })
                        .when(self.failed, |view| {
                            view.child(
                                div().child("Targets unavailable").child(
                                    div()
                                        .id("target-retry")
                                        .cursor_pointer()
                                        .p(px(8.))
                                        .child("Retry")
                                        .on_click(cx.listener(|s, _, _, cx| s.load(cx))),
                                ),
                            )
                        })
                        .when(
                            !self.loading && !self.failed && choices.is_empty(),
                            |view| view.child(P::EMPTY),
                        )
                        .children(choices.into_iter().enumerate().map(|(row, index)| {
                            let id = self.choices[index].id.clone();
                            div()
                                .id(gpui::SharedString::from(format!("target:{id}")))
                                .debug_selector(move || format!("target-{row}"))
                                .cursor_pointer()
                                .p(px(8.))
                                .bg(if self.choice == row {
                                    theme().selection
                                } else {
                                    theme().background
                                })
                                .child(self.choices[index].label.clone())
                                .on_click(cx.listener(move |s, _, window, cx| {
                                    s.attach(id.clone(), window, cx)
                                }))
                        })),
                )
            })
    }
}
impl<P: Port> ShellView for Picker<P> {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        let view = view.read(cx);
        view.child_focus
            .as_ref()
            .unwrap_or(&view.focus)
            .focus(window);
    }
    fn tick(view: &Entity<Self>, _: bool, cx: &mut Context<Shell>) {
        if let Some(child) = view.read(cx).child.clone() {
            P::tick(&child, cx);
        }
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        let view = view.read(cx);
        !view.loading && view.child.as_ref().is_none_or(|child| P::ready(child, cx))
    }
}

/// Adds the surface's own target to the listed choices and opens the saved
/// choice while it is still listed, else the own target.
fn adopt(
    choices: &mut Vec<Choice>,
    requested: &mut Option<String>,
    own: Option<Result<String, String>>,
) {
    let Some(Ok(id)) = own else {
        return;
    };
    if !choices.iter().any(|choice| choice.id == id) {
        choices.push(Choice {
            id: id.clone(),
            label: id.clone(),
        });
    }
    if !requested
        .as_ref()
        .is_some_and(|saved| choices.iter().any(|choice| &choice.id == saved))
    {
        *requested = Some(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::palette::tests::{run, settled};

    fn choice(id: &str) -> Choice {
        Choice {
            id: id.into(),
            label: id.into(),
        }
    }

    #[test]
    fn own_target_opens_when_the_saved_choice_is_not_listed() {
        // A server that leaves the owned shell out of its inventory, with the
        // shell saved by an earlier view of the same surface.
        let mut choices = vec![];
        let mut requested = Some("owned".to_string());
        adopt(&mut choices, &mut requested, Some(Ok("owned".into())));
        assert_eq!(choices.len(), 1);
        assert_eq!(requested.as_deref(), Some("owned"));

        let mut choices = vec![choice("other")];
        let mut requested = Some("gone".to_string());
        adopt(&mut choices, &mut requested, Some(Ok("owned".into())));
        assert_eq!(requested.as_deref(), Some("owned"));
        assert_eq!(choices.len(), 2);
    }

    #[test]
    fn a_listed_saved_choice_stays_and_failures_change_nothing() {
        let mut choices = vec![choice("saved")];
        let mut requested = Some("saved".to_string());
        adopt(&mut choices, &mut requested, Some(Ok("owned".into())));
        assert_eq!(requested.as_deref(), Some("saved"));
        assert!(choices.iter().any(|c| c.id == "owned"));

        let mut choices = vec![choice("saved")];
        let mut requested = None;
        adopt(&mut choices, &mut requested, Some(Err("down".into())));
        adopt(&mut choices, &mut requested, None);
        assert_eq!(requested, None);
        assert_eq!(choices.len(), 1);
    }

    /// A port whose own-target replies are queued per workspace, so a test
    /// controls what creation returns and when the picker sees it.
    struct Owned;
    struct Opened(String);
    impl Render for Opened {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().child(self.0.clone())
        }
    }
    static REPLIES: std::sync::Mutex<
        Vec<(
            &'static str,
            std::collections::VecDeque<Result<String, String>>,
        )>,
    > = std::sync::Mutex::new(Vec::new());
    fn queue(workspace: &'static str, replies: Vec<Result<String, String>>) {
        REPLIES.lock().unwrap().push((workspace, replies.into()));
    }
    impl Port for Owned {
        type View = Opened;
        const TITLE: &'static str = "Owned";
        const EMPTY: &'static str = "None";
        fn choices(_: &Client, _: &str) -> Result<Vec<Choice>, String> {
            Ok(vec![])
        }
        fn create(_: Client, id: String, _: &mut Window, _: &mut Context<Opened>) -> Opened {
            Opened(id)
        }
        fn own(_: &Client, workspace: &str) -> Option<Result<String, String>> {
            let mut replies = REPLIES.lock().unwrap();
            let (_, queued) = replies.iter_mut().find(|(w, _)| *w == workspace)?;
            queued.pop_front()
        }
        fn ready(_: &Entity<Opened>, _: &App) -> bool {
            true
        }
    }
    fn press(
        picker: &mut Picker<Owned>,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Picker<Owned>>,
    ) {
        let event = KeyDownEvent {
            keystroke: gpui::Keystroke::parse(key).unwrap(),
            is_held: false,
        };
        picker.key(&event, window, cx);
    }
    fn paint(cx: &mut gpui::VisualTestContext) {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
    }

    #[gpui::test]
    fn reopening_while_the_own_target_is_created_lists_instead_of_reopening(
        cx: &mut TestAppContext,
    ) {
        queue("reopen-pending", vec![Ok("own-shell".into())]);
        let client = Client::new("http://127.0.0.1:9").unwrap();
        // Ctrl+Alt+O lands before the creation reply, as a person reopening the list does.
        let (picker, cx) = cx.add_window_view(|window, cx| {
            let mut picker = Picker::<Owned>::new(client, "reopen-pending".into(), None, cx);
            press(&mut picker, "ctrl-alt-o", window, cx);
            picker
        });
        paint(cx);
        picker.read_with(cx, |picker, _| {
            assert!(
                picker.child.is_none() && picker.selected.is_none(),
                "the list stays open"
            );
            assert!(!picker.loading);
        });
    }

    #[gpui::test]
    fn an_own_target_creation_error_shows_and_f5_retries(cx: &mut TestAppContext) {
        queue(
            "create-fails",
            vec![
                Err("terminal service refused".into()),
                Ok("own-shell".into()),
            ],
        );
        let client = Client::new("http://127.0.0.1:9").unwrap();
        let (picker, cx) = cx
            .add_window_view(|_, cx| Picker::<Owned>::new(client, "create-fails".into(), None, cx));
        paint(cx);
        assert!(
            cx.debug_bounds("target-own-error").is_some(),
            "the error is shown"
        );
        picker.read_with(cx, |picker, _| assert!(picker.child.is_none()));
        picker.update_in(cx, |picker, window, cx| press(picker, "f5", window, cx));
        paint(cx);
        picker.read_with(cx, |picker, _| {
            assert_eq!(
                picker.selected.as_deref(),
                Some("own-shell"),
                "F5 created and opened it"
            );
            assert!(picker.child.is_some());
        });
    }

    use crate::shell::test_support::*;

    #[gpui::test]
    fn target_click_keeps_identity_when_inventory_reorders(cx: &mut TestAppContext) {
        let fixture = Fixture::start_mode(false, "--review");
        for redraw in [false, true] {
            let (shell, mut visual) = open(
                fixture.client.clone(),
                fixture.root.join(format!("row-race-{redraw}.json")),
                State::default(),
                cx,
            );
            let cx = &mut visual;
            ready(&shell, cx);
            run(cx, "d i f f");
            settled(&shell, cx);
            let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&Tab::Diff)] {
                Content::Diff(v) => v.clone(),
                _ => panic!("diff"),
            });
            let expected = view.read_with(cx, |v, _| v.choices[0].id.clone());
            let bounds = cx.debug_bounds("target-0").unwrap();
            cx.simulate_mouse_down(
                bounds.center(),
                gpui::MouseButton::Left,
                gpui::Modifiers::default(),
            );
            view.update(cx, |v, _| v.choices.reverse());
            if redraw {
                draw(cx);
            }
            cx.simulate_mouse_up(
                bounds.center(),
                gpui::MouseButton::Left,
                gpui::Modifiers::default(),
            );
            settled(&shell, cx);
            let selected = view.read_with(cx, |v, _| v.selected.clone());
            assert!(
                selected == Some(expected) || (redraw && selected.is_none()),
                "a repainted row must cancel the click or retain its original target"
            );
        }
    }

    #[gpui::test]
    fn target_reopen_cancels_pending_restore(cx: &mut TestAppContext) {
        let fixture = Fixture::start_mode(false, "--review");
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join("restore-race.json"),
            State::default(),
            cx,
        );
        let cx = &mut visual;
        ready(&shell, cx);
        shell.update_in(cx, |s, window, cx| {
            s.state
                .workspaces
                .get_mut(s.state.selected.as_deref().unwrap())
                .unwrap()
                .surfaces
                .diff
                .diff_packet = Some("next-review-approve".into());
            s.execute(Command::Diff, window, cx);
            let view = match &s.content[&s.key(&Tab::Diff)] {
                Content::Diff(v) => v.clone(),
                _ => panic!("diff"),
            };
            // Dispatch the production key listener before the background response
            // can update the view; the shell and HTTP entry point are unchanged.
            view.update(cx, |view, cx| {
                view.key(
                    &KeyDownEvent {
                        keystroke: gpui::Keystroke::parse("ctrl-alt-o").unwrap(),
                        is_held: false,
                    },
                    window,
                    cx,
                )
            });
        });
        settled(&shell, cx);
        assert!(
            shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Diff)] {
                Content::Diff(v) => v.read(cx).selected.is_none() && v.read(cx).child.is_none(),
                _ => false,
            })
        );
    }

    #[gpui::test]
    fn target_choices_compare_canonical_workspace_paths(cx: &mut TestAppContext) {
        let fixture = Fixture::start_mode(false, "--review --terminal");
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join("alias.json"),
            State::default(),
            cx,
        );
        let cx = &mut visual;
        ready(&shell, cx);
        let alias = shell.read_with(cx, |s, _| {
            format!("{}/.", s.state.selected.as_deref().unwrap())
        });
        shell.update_in(cx, |s, window, cx| {
            s.workspaces.push(alias.clone());
            s.switch(alias, window, cx);
        });
        run(cx, "d i f f");
        settled(&shell, cx);
        assert_eq!(
            shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Diff)] {
                Content::Diff(v) => v.read(cx).choices.len(),
                _ => 0,
            }),
            2
        );
        run(cx, "t e r m i n a l");
        settled(&shell, cx);
        assert_eq!(
            shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Terminal)] {
                Content::Terminal(v) => v.read(cx).choices.len(),
                _ => 0,
            }),
            1
        );
    }

    #[gpui::test]
    fn target_load_finishing_after_workspace_switch_keeps_composer_focus(cx: &mut TestAppContext) {
        let fixture = Fixture::start_mode(false, "--review");
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join("load-race.json"),
            State::default(),
            cx,
        );
        let cx = &mut visual;
        ready(&shell, cx);
        let other = shell.read_with(cx, |s, _| {
            s.workspaces
                .iter()
                .find(|w| Some(*w) != s.state.selected.as_ref())
                .unwrap()
                .clone()
        });
        shell.update_in(cx, |s, window, cx| {
            s.execute(Command::Diff, window, cx);
            s.switch(other.clone(), window, cx);
            let session = s.workspace_sessions()[0].id.clone();
            s.execute(Command::Message(session), window, cx);
        });
        settled(&shell, cx);
        assert_eq!(
            shell.read_with(cx, |s, _| s.state.selected.clone()),
            Some(other)
        );
        let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&s.active().unwrap())] {
            Content::Session(view) => view.clone(),
            _ => panic!("session"),
        });
        cx.update(|window, cx| assert!(view.read(cx).shell_selection(window, cx).1));
    }
}
