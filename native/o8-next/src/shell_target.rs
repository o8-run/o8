//! Keyboard target selection shared by hosted surfaces; requests stay in each port.
use super::*;
use crate::theme::current as theme;

pub(super) struct Choice {
    pub id: String,
    pub label: String,
}
pub(super) trait Port: 'static {
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
    #[cfg(test)]
    fn ready(view: &Entity<Self::View>, cx: &App) -> bool;
}
pub(super) struct Picker<P: Port> {
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
        };
        view.load(cx);
        view
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        self.failed = false;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx
            .background_executor()
            .spawn(async move { P::choices(&client, &workspace) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.loading = false;
                match result {
                    Ok(mut choices) => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::palette_tests::{run, settled};
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
