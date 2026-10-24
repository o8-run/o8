use super::*;
use crate::theme::current as theme;
impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.projects_open {
            self.ensure(window, cx);
        }
        let revision = self.revision;
        let painted = self.painted.clone();
        let active = self.active();
        let content = self
            .settings
            .as_ref()
            .map(|s| s.clone().into_any_element())
            .or_else(|| {
                if self.projects_open {
                    self.projects.as_ref().map(|p| p.clone().into_any_element())
                } else {
                    active
                        .as_ref()
                        .and_then(|t| self.content.get(&self.key(t)))
                        .map(|c| match c {
                            Content::Brain(brain) => brain.clone().into_any_element(),
                            Content::Session(s) => s.clone().into_any_element(),
                            Content::Grid(g) => g.clone().into_any_element(),
                            Content::Inbox(inbox) => inbox.clone().into_any_element(),
                            Content::Issues(issues) => issues.clone().into_any_element(),
                        })
                }
            });
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .text_size(px(13.))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key_down))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(12.))
                    .p(px(8.))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|_, _, window, _| window.prevent_default()),
                    )
                    .child("o8 next alpha")
                    .child(
                        div()
                            .id("shell-projects")
                            .debug_selector(|| "shell-projects".into())
                            .cursor_pointer()
                            .p(px(6.))
                            .child("Projects")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.open_projects(window, cx)),
                            ),
                    )
                    .when(self.projects_open, |view| {
                        view.child(
                            div()
                                .id("shell-workspace")
                                .debug_selector(|| "shell-workspace".into())
                                .cursor_pointer()
                                .p(px(6.))
                                .child("Back to workspace")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.projects_open = false;
                                    this.restore_focus(window, cx);
                                    cx.notify();
                                })),
                        )
                    })
                    .children(self.workspaces.clone().into_iter().enumerate().map(
                        |(i, workspace)| {
                            let label = std::path::Path::new(&workspace)
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            div()
                                .id(("workspace", i))
                                .debug_selector(move || format!("workspace-{i}"))
                                .cursor_pointer()
                                .p(px(6.))
                                .bg(if self.state.selected.as_ref() == Some(&workspace) {
                                    theme().selection
                                } else {
                                    theme().surface_raised
                                })
                                .child(label)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.switch(workspace.clone(), window, cx)
                                }))
                        },
                    ))
                    .child(
                        div()
                            .id("shell-settings")
                            .debug_selector(|| "shell-settings".into())
                            .cursor_pointer()
                            .p(px(6.))
                            .child("Settings")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.open_settings(window, cx)),
                            ),
                    )
                    .child(
                        div()
                            .id("shell-palette")
                            .cursor_pointer()
                            .p(px(6.))
                            .child("Commands (Ctrl+K / Cmd+K)")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.capture(window, cx);
                                this.palette = true;
                                this.query.clear();
                                this.choice = 0;
                                this.focus.focus(window);
                                this.revision += 1;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("shell-retry")
                            .cursor_pointer()
                            .p(px(6.))
                            .child("Retry")
                            .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                    ),
            )
            .child(
                div()
                    .debug_selector(|| "shell-status".into())
                    .p(px(8.))
                    .child(self.notice.clone()),
            )
            .when(self.palette, |view| {
                view.child(
                    div()
                        .id("command-palette")
                        .debug_selector(|| "command-palette".into())
                        .max_h(px(300.))
                        .overflow_y_scroll()
                        .p(px(12.))
                        .bg(theme().surface_raised)
                        .child(format!("Commands: {}", self.query))
                        .children(self.commands().into_iter().enumerate().map(|(i, command)| {
                            div()
                                .id(("command", i))
                                .p(px(6.))
                                .cursor_pointer()
                                .bg(if i == self.choice {
                                    theme().selection
                                } else {
                                    theme().surface_raised
                                })
                                .child(command.label(&self.sessions))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.execute(command.clone(), window, cx)
                                }))
                        })),
                )
            })
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|_, _, window, _| window.prevent_default()),
                    )
                    .children(
                        self.current()
                            .map(|w| w.tabs.clone())
                            .unwrap_or_default()
                            .into_iter()
                            .enumerate()
                            .map(|(i, t)| {
                                div()
                                    .id(("surface-tab", i))
                                    .cursor_pointer()
                                    .p(px(6.))
                                    .bg(if active.as_ref() == Some(&t) {
                                        theme().selection
                                    } else {
                                        theme().surface_raised
                                    })
                                    .child(t.label())
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.capture(window, cx);
                                        this.projects_open = false;
                                        this.state
                                            .workspaces
                                            .get_mut(this.state.selected.as_deref().unwrap_or(""))
                                            .unwrap()
                                            .active = i;
                                        this.ensure(window, cx);
                                        this.restore_focus(window, cx);
                                        this.persist();
                                        cx.notify();
                                    }))
                            }),
                    ),
            )
            .child(div().flex_1().min_h_0().child(content.unwrap_or_else(|| {
                div()
                    .p(px(24.))
                    .child("Open a saved session or grid from Commands.")
                    .into_any_element()
            })))
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}

pub fn try_launch(args: &[String]) -> Result<bool, String> {
    if !args
        .iter()
        .any(|a| a == "--app-shell" || a == "--shell-state")
    {
        return Ok(false);
    }
    let (mut enabled, mut shell, mut offscreen) = (false, false, false);
    let (mut server, mut file) = (None, None);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--enable-next" => enabled = true,
            "--app-shell" => shell = true,
            "--offscreen" => offscreen = true,
            flag @ ("--server" | "--shell-state") => {
                i += 1;
                let value = args
                    .get(i)
                    .filter(|v| !v.starts_with("--"))
                    .ok_or("Missing shell flag value")?
                    .clone();
                if flag == "--server" {
                    if server.replace(value).is_some() {
                        return Err("Duplicate shell server".into());
                    }
                } else if file.replace(PathBuf::from(value)).is_some() {
                    return Err("Duplicate shell state".into());
                }
            }
            _ => {
                return Err(
                    "App shell accepts only server, state, opt-in and offscreen flags".into(),
                );
            }
        }
        i += 1;
    }
    if !enabled || !shell {
        return Err("App shell requires --enable-next and --app-shell".into());
    }
    let file = file
        .filter(|p| p.is_absolute())
        .ok_or("Pass --shell-state with an absolute file")?;
    let state = State::load(&file)?;
    let client = Client::new(
        &server.ok_or("Pass --server; use o8 next for local configuration discovery")?,
    )?;
    launch(client, file, state, offscreen);
    Ok(true)
}
fn launch(client: Client, file: PathBuf, state: State, offscreen: bool) {
    (if offscreen {
        Application::headless()
    } else {
        Application::new()
    })
    .run(move |cx: &mut App| {
        let handle = open_window(client, file, state, offscreen, cx);
        cx.spawn(async move |cx| {
            let mut ticks = 0;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(20))
                    .await;
                ticks += 1;
                if handle
                    .update(cx, |s, window, cx| s.tick(ticks % 50 == 0, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}

pub(super) fn open_window(
    client: Client,
    file: PathBuf,
    state: State,
    offscreen: bool,
    cx: &mut App,
) -> gpui::WindowHandle<Shell> {
    let [x, y, w, h] = state.bounds;
    cx.open_window(
        WindowOptions {
            focus: false,
            show: !offscreen,
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                point(px(x), px(y)),
                size(px(w), px(h)),
            ))),
            window_min_size: Some(size(px(600.), px(400.))),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("o8 next".into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        |window, cx| cx.new(|cx| Shell::new(client, file, state, window, cx)),
    )
    .expect("GPUI shell window")
}
