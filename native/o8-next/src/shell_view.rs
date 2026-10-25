use super::*;
use crate::theme::current as theme;
impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for extension in registry::extensions() {
            extension.prepare(self, window, cx);
        }
        let frame = registry::extensions()
            .find_map(|extension| extension.frame(self))
            .unwrap_or_default();
        if !registrations().iter().any(|r| (r.block_ensure)(self)) {
            self.ensure(window, cx);
        }
        let revision = self.revision;
        let painted = self.painted.clone();
        let active = self.active();
        let content = registrations()
            .iter()
            .find_map(|r| (r.overlay)(self))
            .or_else(|| {
                active
                    .as_ref()
                    .and_then(|t| self.content.get(&self.key(t)))
                    .map(Content::element)
            });
        let mut style = gpui::StyleRefinement::default();
        style.size.width = Some(gpui::relative(1.).into());
        style.flex_shrink = Some(0.);
        let chrome = self.chrome.measured_view(
            "shell-chrome",
            style,
            Self::render_chrome,
            window.viewport_size().width,
            cx,
        );
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(if self.system_glass {
                theme().background
            } else {
                crate::theme::plain_background()
            })
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(crate::theme::TYPE.weight)
            .text_size(px(crate::theme::TYPE.chrome))
            .line_height(gpui::relative(crate::theme::TYPE.chrome_line))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key_down))
            .when(self.system_glass, |view| view.child(material::veil()))
            .child(chrome)
            .child(
                registrations().iter().fold(
                    div()
                        .flex_1()
                        .min_h_0()
                        .child(content.unwrap_or_else(|| {
                            div().p(px(24.)).child(frame.empty).into_any_element()
                        }))
                        .into_any_element(),
                    |content, registration| (registration.decorate)(self, content),
                ),
            )
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}

impl Shell {
    fn render_chrome(&mut self, _: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let frame = registry::extensions()
            .find_map(|e| e.frame(self))
            .unwrap_or_default();
        let active = self.active();
        let before_workspaces = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::BeforeWorkspaces, cx))
            .collect::<Vec<_>>();
        let after_workspaces = registrations()
            .iter()
            .flat_map(|r| (r.nav)(self, NavPosition::AfterWorkspaces, cx))
            .collect::<Vec<_>>();
        div()
            .w_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .flex_shrink_0()
                    .gap(px(12.))
                    .p(px(8.))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|_, _, window, _| window.prevent_default()),
                    )
                    .children(
                        frame
                            .brand
                            .map(|brand| div().debug_selector(move || brand.into()).child(brand)),
                    )
                    .children(before_workspaces)
                    .child(
                        div()
                            .id("workspace-switcher")
                            .debug_selector(|| "workspace-switcher".into())
                            .max_w(px(220.))
                            .overflow_hidden()
                            .p(px(6.))
                            .cursor_pointer()
                            .child(
                                self.state
                                    .selected
                                    .as_deref()
                                    .and_then(|path| std::path::Path::new(path).file_name())
                                    .map(|name| name.to_string_lossy().to_string())
                                    .unwrap_or_else(|| "Workspaces".into()),
                            )
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.capture(window, cx);
                                this.palette = true;
                                this.workspace_picker = true;
                                this.shortcuts = false;
                                this.query.clear();
                                this.choice = 0;
                                this.palette_scroll.scroll_to_item(1);
                                this.focus.focus(window);
                                cx.notify();
                            })),
                    )
                    .children(after_workspaces)
                    .child(
                        div()
                            .id("shell-palette")
                            .cursor_pointer()
                            .p(px(6.))
                            .child(
                                div()
                                    .debug_selector(move || frame.commands.into())
                                    .child(frame.commands),
                            )
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.capture(window, cx);
                                this.palette = true;
                                this.workspace_picker = false;
                                this.shortcuts = false;
                                this.query.clear();
                                this.choice = 0;
                                this.palette_scroll.scroll_to_item(1);
                                this.focus.focus(window);
                                this.revision += 1;
                                cx.notify();
                            })),
                    )
                    .when(frame.retry, |view| {
                        view.child(
                            div()
                                .id("shell-retry")
                                .cursor_pointer()
                                .p(px(6.))
                                .child("Retry")
                                .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                        )
                    }),
            )
            .when(frame.status, |view| {
                view.child(
                    div()
                        .debug_selector(|| "shell-status".into())
                        .p(px(8.))
                        .child(self.notice.clone()),
                )
            })
            .when(self.shortcuts, |view| {
                view.child(
                    div()
                        .debug_selector(|| "shortcut-reference".into())
                        .p(px(12.))
                        .children(
                            [
                                "Ctrl+K / Cmd+K: Commands",
                                "Ctrl+Tab: Next surface",
                                "Ctrl+W: Close surface",
                                "Enter: Send",
                                "Shift+Enter: New line",
                                "Ctrl+Shift+Enter: Switch send mode",
                                "F6: Steer queued",
                                "F7: Remove queued",
                                "Escape: Close",
                            ]
                            .into_iter()
                            .map(|key| div().p(px(6.)).child(key)),
                        ),
                )
            })
            .when(self.palette, |view| {
                if let Some(palette) =
                    registry::extensions().find_map(|extension| extension.palette(self, cx))
                {
                    return view.child(palette);
                }
                view.child(
                    div()
                        .id("command-palette")
                        .debug_selector(|| "command-palette".into())
                        .max_h(px(300.))
                        .overflow_y_scroll()
                        .track_scroll(&self.palette_scroll)
                        .p(px(12.))
                        .bg(theme().surface_raised)
                        .child(format!("Commands: {}", self.query))
                        .children(self.commands().into_iter().enumerate().map(|(i, command)| {
                            div()
                                .id(("command", i))
                                .debug_selector(move || format!("command-{i}"))
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
                    .h(px(crate::theme::GEOMETRY.header))
                    .items_center()
                    .gap(px(crate::theme::GEOMETRY.gap))
                    .id("surface-tabs")
                    .overflow_x_scroll()
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
                                    .debug_selector(move || format!("surface-tab-{i}"))
                                    .cursor_pointer()
                                    .h(px(crate::theme::GEOMETRY.tab_height))
                                    .px(px(crate::theme::GEOMETRY.gap))
                                    .flex()
                                    .items_center()
                                    .flex_shrink_0()
                                    .rounded(px(crate::theme::GEOMETRY.tab_radius))
                                    .bg(if active.as_ref() == Some(&t) {
                                        theme().selection
                                    } else {
                                        theme().surface_raised
                                    })
                                    .child(match &t {
                                        Tab::Session(id) => {
                                            let selected = self
                                                .current()
                                                .and_then(|w| w.selections.get(id))
                                                .unwrap_or(id);
                                            self.sessions
                                                .iter()
                                                .find(|s| &s.id == selected)
                                                .map(|s| s.title.clone())
                                                .unwrap_or_else(|| "Chat".into())
                                        }
                                        _ => t.label().into(),
                                    })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.capture(window, cx);
                                        for registration in registrations() {
                                            (registration.after_tab)(this);
                                        }
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
            .into_any_element()
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
        let (sender, receiver) = async_channel::bounded(1);
        let client = client.with_wakeup(sender);
        let handle = open_window(client, file, state, offscreen, cx);
        start_pump(handle, receiver, cx);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}

pub(super) fn start_pump(
    handle: gpui::WindowHandle<Shell>,
    receiver: async_channel::Receiver<()>,
    cx: &mut App,
) {
    cx.spawn(async move |cx| {
        let mut timer = cx.background_executor().timer(Duration::from_secs(1));
        loop {
            let refresh = crate::wake::next(&receiver, &mut timer).await;
            if refresh {
                timer = cx.background_executor().timer(Duration::from_secs(1));
            }
            if handle
                .update(cx, |s, window, cx| s.tick(refresh, window, cx))
                .is_err()
            {
                break;
            }
        }
    })
    .detach();
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
            window_background: material::background(offscreen),
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
        |window, cx| {
            cx.new(|cx| {
                let system_glass = material::apply(window, offscreen);
                let mut shell = Shell::new(client, file, state, window, cx);
                shell.system_glass = system_glass;
                shell
            })
        },
    )
    .expect("GPUI shell window")
}
