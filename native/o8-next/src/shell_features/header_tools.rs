use super::*;
use serde_json::Value;
// The header's right-side tools: Play (HeaderPlayButton, add a pane) and
// Workspace tools (WorkspaceToolsButton and its BranchDetailsOverlay card).
struct HeaderTools;
register_shell_feature!(HeaderTools);
impl ShellFeature for HeaderTools {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 80,
            dispatch: |s, event, window, cx| {
                let menus = s.features.get::<Menus>();
                if event.keystroke.key == "escape" && (menus.play || menus.tools) {
                    close(s, window, cx);
                    return KeyResult::Handled;
                }
                KeyResult::Unhandled
            },
        }]
    }
}

#[derive(Default)]
struct Menus {
    play: bool,
    tools: bool,
    /// The workspace the snapshot below was read for.
    scope: Option<String>,
    loading: bool,
    snapshot: Option<Snapshot>,
    error: Option<String>,
    /// When the open card started its 150ms appearance.
    opened: Option<std::time::Instant>,
}

/// The fields of /api/review/workspace the card shows.
#[derive(Clone, Default)]
struct Snapshot {
    branch: Option<String>,
    repo: Option<String>,
    path: Option<String>,
    files: usize,
    additions: u64,
    deletions: u64,
    pull_request: Option<(u64, String)>,
}

impl Snapshot {
    fn read(body: &Value) -> Self {
        let files = body["changedFiles"].as_array().cloned().unwrap_or_default();
        let sum = |field: &str| files.iter().filter_map(|file| file[field].as_u64()).sum();
        let branch = body["branch"].as_str().filter(|b| !b.is_empty()).map(String::from);
        let pull_request = body["pullRequests"].as_array().and_then(|prs| {
            prs.iter()
                .find(|pr| pr["headRefName"].as_str() == branch.as_deref())
                .and_then(|pr| Some((pr["number"].as_u64()?, pr["title"].as_str()?.to_string())))
        });
        Self {
            branch,
            repo: body["repoSlug"].as_str().filter(|r| !r.is_empty()).map(String::from),
            path: body["repoPath"].as_str().filter(|p| !p.is_empty()).map(String::from),
            files: files.len(),
            additions: sum("additions"),
            deletions: sum("deletions"),
            pull_request,
        }
    }
}

/// Whether a header card or menu is open (native views hide under it).
pub(super) fn any_open(s: &Shell) -> bool {
    s.features.read::<Menus>().is_some_and(|menus| menus.play || menus.tools)
}

fn close(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let menus = s.features.get::<Menus>();
    menus.play = false;
    menus.tools = false;
    s.restore_focus(window, cx);
    cx.notify();
}

/// Reads the workspace's Git context, first the fast local view, then again
/// with pull requests (the slow `gh` path).
fn load(s: &mut Shell, cx: &mut Context<Shell>) {
    let Some(workspace) = s.state.selected.clone() else {
        return;
    };
    let menus = s.features.get::<Menus>();
    if menus.scope.as_deref() != Some(workspace.as_str()) {
        menus.snapshot = None;
    }
    menus.scope = Some(workspace.clone());
    menus.loading = true;
    menus.error = None;
    let client = s.client.in_workspace(&workspace);
    for changes_only in [true, false] {
        let client = client.clone();
        let path = workspace.clone();
        let task = cx.background_executor().spawn(async move {
            let mut query = vec![("workspace", path.as_str())];
            if changes_only {
                query.push(("changesOnly", "1"));
            }
            client.get::<Value>("/api/review/workspace", &query)
        });
        let scope = workspace.clone();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                let menus = this.features.get::<Menus>();
                if menus.scope.as_deref() != Some(scope.as_str()) {
                    return;
                }
                menus.loading = false;
                match result {
                    Ok(body) => {
                        let mut next = Snapshot::read(&body);
                        // The fast read has no pull requests; keep one already found.
                        if changes_only && next.pull_request.is_none() {
                            next.pull_request = menus.snapshot.as_ref().and_then(|s| s.pull_request.clone());
                        }
                        menus.snapshot = Some(next);
                    }
                    Err(error) if menus.snapshot.is_none() => menus.error = Some(error),
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }
}

/// Play: opens the add-pane menu (Chat, Terminal).
pub(super) fn play(s: &mut Shell, window: &Window, cx: &mut Context<Shell>) -> impl IntoElement {
    let open = s.features.get::<Menus>().play;
    let appear = appear(s, window);
    div()
        .relative()
        .flex_shrink_0()
        .child(
            super::header::pill("header-play", "Add a pane", true)
                .w(px(30.))
                .when(open, |button| button.bg(theme().hover))
                .child(crate::icon::stroke(PLAY, theme().text_secondary, 14., 1.8))
                .on_click(cx.listener(|this, _, _, cx| {
                    let menus = this.features.get::<Menus>();
                    menus.play = !menus.play;
                    menus.tools = false;
                    menus.opened = Some(std::time::Instant::now());
                    cx.notify();
                })),
        )
        .when(open, |wrapper| {
            wrapper.child(popover(
                "header-play-menu",
                220.,
                appear,
                div()
                    .py(px(4.))
                    .child(item("header-play-chat", "Chat", cx, |this, window, cx| {
                        match this.workspace_sessions().first().map(|s| s.id.clone()) {
                            Some(id) => this.execute(Command::Message(id), window, cx),
                            None => this.execute(Command::Setup, window, cx),
                        }
                    }))
                    .child(item("header-play-terminal", "Terminal", cx, |this, window, cx| {
                        this.execute(Command::Terminal, window, cx)
                    })),
                cx,
            ))
        })
}

/// Workspace tools: the circles-and-lines button and its workspace card.
pub(super) fn tools(s: &mut Shell, window: &Window, cx: &mut Context<Shell>) -> impl IntoElement {
    let appear = appear(s, window);
    let menus = s.features.get::<Menus>();
    let open = menus.tools;
    let card = open.then(|| card(menus, s.state.selected.clone(), cx));
    div()
        .relative()
        .flex_shrink_0()
        .child(
            super::header::pill("header-workspace-tools", "Workspace tools", true)
                .w(px(30.))
                .when(open, |button| button.bg(theme().hover))
                .child(crate::icon::stroke(TOOLS, theme().text_secondary, 16., 1.6))
                .on_click(cx.listener(|this, _, _, cx| {
                    let menus = this.features.get::<Menus>();
                    menus.tools = !menus.tools;
                    menus.play = false;
                    menus.opened = Some(std::time::Instant::now());
                    if menus.tools {
                        load(this, cx);
                    }
                    cx.notify();
                })),
        )
        .when_some(card, |wrapper, card| {
            wrapper.child(popover("header-workspace-card", 304., appear, card, cx))
        })
}

fn card(menus: &Menus, workspace: Option<String>, cx: &mut Context<Shell>) -> gpui::Div {
    let snapshot = menus.snapshot.clone().unwrap_or_default();
    let name = snapshot
        .repo
        .as_deref()
        .and_then(|repo| repo.rsplit('/').next())
        .or_else(|| workspace.as_deref().and_then(|path| path.trim_end_matches('/').rsplit('/').next()))
        .unwrap_or("Home")
        .to_string();
    let branch = match (&snapshot.branch, menus.loading, &menus.error) {
        (Some(branch), _, _) if branch == "(detached)" => "Detached HEAD".to_string(),
        (Some(branch), _, _) => branch.clone(),
        (None, true, _) => "Reading Git context…".into(),
        (None, _, Some(_)) => "Git context couldn’t load".into(),
        (None, _, None) => "No Git branch".into(),
    };
    let path = snapshot.path.clone().or(workspace.clone()).unwrap_or_default();
    let summary = if menus.snapshot.is_none() {
        None
    } else if snapshot.files == 0 {
        Some("Working tree clean".to_string())
    } else {
        Some(format!(
            "{} changed {}",
            snapshot.files,
            if snapshot.files == 1 { "file" } else { "files" }
        ))
    };
    let meta = |text: String| {
        div()
            .text_size(px(9.5))
            .font_weight(crate::theme::TYPE.meta_weight)
            .text_color(theme().text_muted)
            .child(text)
    };
    div()
        .px(px(14.))
        .pt(px(12.))
        .pb(px(14.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .flex()
                .flex_col()
                .pb(px(10.))
                .border_b_1()
                .border_color(theme().border)
                .child(
                    div()
                        .h(px(28.))
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_size(px(10.))
                        .text_color(theme().text_muted)
                        .child("Workspace")
                        .child(
                            action("workspace-refresh", cx, |this, _, cx| {
                                this.features.get::<Menus>().tools = true;
                                load(this, cx);
                            })
                            .px(px(5.))
                            .child(crate::icon::stroke(REFRESH, theme().text_secondary, 13., 1.6)),
                        ),
                )
                .child(
                    div()
                        .mt(px(3.))
                        .flex()
                        .items_center()
                        .gap(px(7.))
                        .child(crate::icon::stroke(FOLDER, theme().text_muted, 15., 1.6))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(13.5))
                                .child(name),
                        )
                        .when(workspace.is_some(), |row| row.child(meta("Local checkout".into()))),
                )
                .child(
                    div()
                        .mt(px(7.))
                        .flex()
                        .items_center()
                        .gap(px(7.))
                        .text_color(theme().text_secondary)
                        .child(crate::icon::stroke(BRANCH, theme().text_muted, 13., 1.6))
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(12.))
                                .child(branch),
                        ),
                )
                .child(
                    div()
                        .mt(px(3.))
                        .flex()
                        .items_center()
                        .gap(px(3.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child(meta(home_relative(&path))),
                        )
                        .child({
                            let copied = path.clone();
                            div()
                                .id("workspace-copy-path")
                                .debug_selector(|| "workspace-copy-path".into())
                                .min_h(px(24.))
                                .px(px(5.))
                                .flex()
                                .items_center()
                                .rounded(px(8.))
                                .cursor_pointer()
                                .hover(|button| button.bg(theme().hover))
                                .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Copy workspace path".into())).into())
                                .child(crate::icon::stroke(COPY, theme().text_secondary, 12., 1.6))
                                .on_click(move |_, _, cx| {
                                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(copied.clone()))
                                })
                        }),
                )
                .child(
                    div()
                        .mt(px(7.))
                        .flex()
                        .gap(px(4.))
                        .child(action("workspace-changes", cx, |this, window, cx| {
                            this.execute(Command::Diff, window, cx)
                        })
                        .flex_1()
                        .child(div().mr(px(2.)).text_size(px(15.)).child("±"))
                        .child("Changes")
                        .child(div().ml_auto().child(meta(if menus.snapshot.is_some() {
                            snapshot.files.to_string()
                        } else {
                            "…".into()
                        }))))
                        .child(action("workspace-pull-requests", cx, |this, window, cx| {
                            this.execute(Command::PullRequests, window, cx)
                        })
                        .flex_1()
                        .child(crate::icon::stroke(PULL_REQUEST, theme().text_secondary, 14., 1.6))
                        .child("Pull requests")),
                )
                .when_some(summary, |section, summary| {
                    section.child(
                        div()
                            .mt(px(4.))
                            .flex()
                            .gap(px(6.))
                            .child(meta(summary))
                            .when(snapshot.files > 0, |row| {
                                row.child(
                                    div()
                                        .text_size(px(9.5))
                                        .text_color(theme().success)
                                        .child(format!("+{}", snapshot.additions)),
                                )
                                .child(
                                    div()
                                        .text_size(px(9.5))
                                        .text_color(theme().danger)
                                        .child(format!("−{}", snapshot.deletions)),
                                )
                            }),
                    )
                }),
        )
        .when_some(snapshot.pull_request.clone(), |card, (number, title)| {
            card.child(
                div()
                    .pt(px(8.))
                    .pb(px(9.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(
                        div()
                            .h(px(22.))
                            .flex()
                            .items_center()
                            .text_size(px(10.))
                            .text_color(theme().text_muted)
                            .child("Pull request"),
                    )
                    .child(
                        action("workspace-pull-request", cx, |this, window, cx| {
                            this.execute(Command::PullRequests, window, cx)
                        })
                        .w_full()
                        .child(crate::icon::stroke(PULL_REQUEST, theme().text_secondary, 14., 1.6))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child(format!("#{number} {title}")),
                        ),
                    ),
            )
        })
        .child(
            div()
                .pt(px(8.))
                .flex()
                .justify_between()
                .gap(px(4.))
                .child(
                    action("workspace-inbox", cx, |this, window, cx| {
                        super::right_panel::open(this, window, cx)
                    })
                    .child(crate::icon::stroke(INBOX, theme().text_secondary, 14., 1.6))
                    .child("Inbox"),
                ),
        )
}

/// The open card's 150ms appearance (the desktop overlay's scale-in from its
/// trigger), as opacity and a short drop.
fn appear(s: &Shell, window: &Window) -> f32 {
    let Some(opened) = s.features.read::<Menus>().and_then(|menus| menus.opened) else {
        return 1.;
    };
    let t = opened.elapsed().as_secs_f32() / 0.15;
    if t < 1. {
        window.request_animation_frame();
    }
    crate::motion::ease_out(t.min(1.))
}

/// `~/o8` for a path under the home directory, as the desktop card shows it.
fn home_relative(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && path.starts_with(&home) => format!("~{}", &path[home.len()..]),
        _ => path.to_string(),
    }
}

/// A floating card under its trigger, right-aligned to it, over a backdrop
/// that closes it when the pointer lands anywhere else.
fn popover(
    id: &'static str,
    width: f32,
    appear: f32,
    child: impl IntoElement,
    cx: &mut Context<Shell>,
) -> impl IntoElement {
    div()
        .absolute()
        .top(px(30.))
        .right(px(0.))
        .child(
            gpui::deferred(
                gpui::anchored()
                    .position(gpui::point(px(0.), px(0.)))
                    .child(
                        div()
                            .id("header-popover-backdrop")
                            .size(gpui::relative(1.))
                            .w(px(100_000.))
                            .h(px(100_000.))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(|this, _, window, cx| close(this, window, cx)),
                            ),
                    ),
            )
            .with_priority(1),
        )
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::TopRight)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        div()
                            .id(id)
                            .debug_selector(move || id.into())
                            .occlude()
                            .w(px(width))
                            .opacity(appear)
                            .relative()
                            .top(px(-6. * (1. - appear)))
                            .rounded(px(12.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .text_size(px(13.))
                            .text_color(theme().text)
                            .child(child),
                    ),
            )
            .with_priority(2),
        )
}

/// One row of the Play menu.
fn item(
    id: &'static str,
    label: &'static str,
    cx: &mut Context<Shell>,
    run: fn(&mut Shell, &mut Window, &mut Context<Shell>),
) -> impl IntoElement {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .mx(px(4.))
        .h(px(30.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .cursor_pointer()
        .hover(|row| row.bg(theme().hover))
        .child(label)
        .on_click(cx.listener(move |this, _, window, cx| {
            this.capture(window, cx);
            close(this, window, cx);
            run(this, window, cx);
        }))
}

/// The card's flat buttons (WorkspaceContextSection's Action).
fn action(
    id: &'static str,
    cx: &mut Context<Shell>,
    run: fn(&mut Shell, &mut Window, &mut Context<Shell>),
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .min_h(px(30.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(8.))
        .cursor_pointer()
        .text_size(px(11.))
        .text_color(theme().text_secondary)
        .hover(|button| button.bg(theme().hover))
        .on_click(cx.listener(move |this, _, window, cx| {
            this.capture(window, cx);
            close(this, window, cx);
            run(this, window, cx);
        }))
}

const PLAY: &str = "M7 4.5 20 12 7 19.5Z";
const TOOLS: &str = "M5 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M5 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M11 7h10 M11 17h10";
const FOLDER: &str = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const BRANCH: &str = "M6 3v12 M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M18 12a9 9 0 0 1-9 9";
const PULL_REQUEST: &str = "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12";
const INBOX: &str = "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z";
const REFRESH: &str = "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5";
const COPY: &str = "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2";
