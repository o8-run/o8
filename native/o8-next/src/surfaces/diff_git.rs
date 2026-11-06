//! Review's Commit, Push and Open pull request, over classic Review's routes
//! (`/api/review/commit`, `/api/review/push`). Shown above the working
//! changes; a packet's diff has no Git actions.
use crate::composer::{Composer, Submit};
use crate::diff_ui::DiffSurface;
use crate::theme::current as theme;
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::time::Duration;

/// Open pull request is off on these, as in classic.
const DEFAULT_BRANCHES: [&str; 2] = ["main", "master"];
/// What the workspace snapshot says instead of a branch: `git status`'s
/// detached head, and the route's fallback.
const NOT_A_BRANCH: [&str; 3] = ["HEAD", "(detached)", "unknown"];
const TOAST: Duration = Duration::from_millis(4500);
/// Commit runs hooks for up to 15 s and push may take 30 s on the server, so
/// the client's 5 s agent deadline would give up on a commit that lands.
const POST_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(2)
} else {
    crate::client::LOAD_REQUEST_TIMEOUT
};

fn can_open_pull_request(branch: Option<&str>) -> bool {
    branch.is_some_and(|b| {
        !b.is_empty() && !NOT_A_BRANCH.contains(&b) && !DEFAULT_BRANCHES.contains(&b)
    })
}

/// A branch as one URL path: `/` kept, everything outside Git's usual
/// characters percent-encoded.
fn encode_branch(branch: &str) -> String {
    branch
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// GitHub's form for a new pull request from `branch`; `None` on a default
/// branch, a detached head or an unknown branch.
pub(crate) fn pull_request_url(slug: Option<&str>, branch: Option<&str>) -> Option<String> {
    let branch = branch.filter(|b| can_open_pull_request(Some(b)))?;
    let slug = slug.filter(|s| s.contains('/'))?;
    Some(format!(
        "https://github.com/{slug}/compare/{}?expand=1",
        encode_branch(branch)
    ))
}

/// A Git route's answer.
#[derive(Debug)]
enum Reply {
    Done(Value),
    /// The route answered with an error, or the request never left.
    Refused(String),
    /// Sent, but no answer came: the commit or push may still have landed.
    Unknown,
}

fn post(client: &crate::client::Client, path: &str, body: Value) -> Reply {
    let Ok(url) = client.url(path) else {
        return Reply::Refused(format!("Bad route {path}"));
    };
    match client
        .request("POST", &url)
        .timeout(POST_TIMEOUT)
        .send_json(body)
    {
        Ok(response) => match crate::client::Client::read(response) {
            Ok(reply) => Reply::Done(reply),
            Err(error) => Reply::Refused(error),
        },
        // The routes answer `{error}` with the Git message.
        Err(ureq::Error::Status(code, response)) => {
            let body: Value = response.into_json().unwrap_or_default();
            Reply::Refused(
                body["error"]
                    .as_str()
                    .map_or_else(|| format!("HTTP {code}"), str::to_owned),
            )
        }
        // A read that timed out or broke after sending.
        Err(ureq::Error::Transport(error)) if error.kind() == ureq::ErrorKind::Io => Reply::Unknown,
        Err(error) => Reply::Refused(error.to_string()),
    }
}

/// The workspace's branch and GitHub repository, from the snapshot classic's
/// Review header reads; `fresh` asks for Git's current state.
fn snapshot(
    client: &crate::client::Client,
    workspace: &str,
) -> Option<(Option<String>, Option<String>)> {
    let body: Value = client
        .get(
            "/api/review/workspace",
            &[
                ("workspace", workspace),
                ("changesOnly", "1"),
                ("fresh", "1"),
            ],
        )
        .ok()?;
    let text = |key: &str| {
        body[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Some((text("branch"), text("repoSlug")))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Busy {
    Committing,
    Pushing,
}

pub(crate) struct GitActions {
    client: crate::client::Client,
    workspace: String,
    diff: WeakEntity<DiffSurface>,
    focus: FocusHandle,
    pub(crate) branch: Option<String>,
    pub(crate) slug: Option<String>,
    pub(crate) menu: bool,
    pub(crate) composing: bool,
    pub(crate) busy: Option<Busy>,
    pub(crate) input: Entity<Composer>,
    pub(crate) error: Option<String>,
    /// The last outcome, and whether it failed.
    pub(crate) toast: Option<(String, bool)>,
    toast_generation: u64,
    _submit: Subscription,
}

impl GitActions {
    pub(crate) fn new(
        client: crate::client::Client,
        workspace: String,
        diff: WeakEntity<DiffSurface>,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.placeholder = "Commit message…".into();
            // A textarea: Enter adds a line and ⌘↵ commits, as in classic.
            input.newline_on_enter = true;
            input
        });
        let _submit = cx.subscribe(&input, |this, _, _: &Submit, cx| this.commit(cx));
        let mut actions = Self {
            client,
            workspace,
            diff,
            focus: cx.focus_handle(),
            branch: None,
            slug: None,
            menu: false,
            composing: false,
            busy: None,
            input,
            error: None,
            toast: None,
            toast_generation: 0,
            _submit,
        };
        actions.read_branch(cx);
        actions
    }

    /// Reads the branch again: on opening, and after every commit or push.
    fn read_branch(&mut self, cx: &mut Context<Self>) {
        let (client, workspace) = (self.client.clone(), self.workspace.clone());
        let task = cx
            .background_executor()
            .spawn(async move { snapshot(&client, &workspace) });
        cx.spawn(async move |this, cx| {
            let Some((branch, slug)) = task.await else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                this.branch = branch;
                this.slug = slug;
                cx.notify();
            });
        })
        .detach();
    }

    fn say(&mut self, text: String, failed: bool, cx: &mut Context<Self>) {
        self.toast = Some((text, failed));
        self.toast_generation += 1;
        let generation = self.toast_generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOAST).await;
            let _ = this.update(cx, |this, cx| {
                if this.toast_generation == generation {
                    this.toast = None;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    /// Runs `work` off the UI thread, then `done` with its result; the
    /// branch is read again afterwards.
    fn run<T: Send + 'static>(
        &mut self,
        busy: Busy,
        cx: &mut Context<Self>,
        work: impl FnOnce(crate::client::Client) -> T + Send + 'static,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(busy);
        self.menu = false;
        cx.notify();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move { work(client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                done(this, result, cx);
                this.read_branch(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn reload_diff(&mut self, cx: &mut Context<Self>) {
        let _ = self.diff.update(cx, |diff, cx| diff.load(cx));
    }

    pub(crate) fn commit(&mut self, cx: &mut Context<Self>) {
        let message = self.input.read(cx).text.trim().to_owned();
        if message.is_empty() {
            return;
        }
        self.error = None;
        let body = json!({ "message": message, "workspace": self.workspace });
        self.run(
            Busy::Committing,
            cx,
            move |client| post(&client, "/api/review/commit", body),
            |this, reply, cx| match reply {
                Reply::Done(reply) => {
                    let hash = reply["hash"].as_str().unwrap_or_default();
                    this.say(format!("Committed {hash}").trim().to_owned(), false, cx);
                    this.composing = false;
                    this.input.update(cx, |input, cx| input.set_text("", cx));
                    // The committed files leave the working changes.
                    this.reload_diff(cx);
                }
                Reply::Refused(error) => this.error = Some(error),
                // A slow hook can outlast the request while the commit
                // lands: show what Git has now, never a false failure that
                // invites a second commit.
                Reply::Unknown => {
                    this.composing = false;
                    this.say(
                        "No reply from the commit in time. It may have landed; the changes are reloading.".into(),
                        true,
                        cx,
                    );
                    this.reload_diff(cx);
                }
            },
        );
    }

    pub(crate) fn push(&mut self, cx: &mut Context<Self>) {
        let body = json!({ "workspace": self.workspace });
        self.run(
            Busy::Pushing,
            cx,
            move |client| post(&client, "/api/review/push", body),
            |this, reply, cx| match reply {
                Reply::Done(reply) => {
                    let text = reply["message"].as_str().unwrap_or("Pushed").to_owned();
                    this.say(text, false, cx);
                }
                Reply::Refused(error) => this.say(error, true, cx),
                Reply::Unknown => this.say(
                    "No reply from the push in time. It may have landed; check the branch on GitHub.".into(),
                    true,
                    cx,
                ),
            },
        );
    }

    /// Reads the branch now, pushes it, then opens GitHub's form for a new
    /// pull request from the branch the push named.
    pub(crate) fn open_pull_request(&mut self, cx: &mut Context<Self>) {
        if !can_open_pull_request(self.branch.as_deref()) {
            return;
        }
        let (workspace, body) = (
            self.workspace.clone(),
            json!({ "workspace": self.workspace }),
        );
        self.run(
            Busy::Pushing,
            cx,
            move |client| {
                let (branch, slug) = snapshot(&client, &workspace).unwrap_or_default();
                if !can_open_pull_request(branch.as_deref()) {
                    return Err(branch);
                }
                Ok((slug, post(&client, "/api/review/push", body)))
            },
            |this, result, cx| match result {
                Err(branch) => this.say(
                    format!(
                        "Open pull request needs a feature branch; this is {}.",
                        branch.as_deref().unwrap_or("not a branch")
                    ),
                    true,
                    cx,
                ),
                Ok((slug, Reply::Done(reply))) => {
                    match pull_request_url(slug.as_deref(), reply["branch"].as_str()) {
                        Some(url) => {
                            cx.open_url(&url);
                            this.say("Pushed. Opening the pull request form.".into(), false, cx);
                        }
                        None => this.say("Pushed. Open the pull request on GitHub.".into(), false, cx),
                    }
                }
                Ok((_, Reply::Refused(error))) => this.say(error, true, cx),
                Ok((_, Reply::Unknown)) => this.say(
                    "No reply from the push in time. It may have landed; check the branch on GitHub.".into(),
                    true,
                    cx,
                ),
            },
        );
    }

    fn open_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composing = !self.composing;
        self.menu = false;
        self.error = None;
        if self.composing {
            self.input.read(cx).focus.focus(window);
        }
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.menu = false;
        self.composing = false;
        cx.notify();
    }
}

fn face(id: &'static str, label: impl Into<SharedString>, enabled: bool) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .h_full()
        .px(px(9.))
        .flex()
        .items_center()
        .text_size(px(11.5))
        .text_color(if enabled {
            theme().text
        } else {
            theme().text_faint
        })
        .when(enabled, |face| {
            face.cursor_pointer().hover(|face| face.bg(theme().hover))
        })
        .child(label.into())
}

fn row(id: &'static str, label: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .h(px(28.))
        .px(px(9.))
        .flex()
        .items_center()
        .rounded(px(7.))
        .text_size(px(12.))
        .cursor_pointer()
        .hover(|row| row.bg(theme().hover))
        .child(label)
}

fn popover(id: &'static str, width: f32, body: impl IntoElement) -> AnyElement {
    deferred(
        anchored()
            .anchor(Corner::TopRight)
            .snap_to_window_with_margin(px(12.))
            .child(
                div()
                    .id(id)
                    .debug_selector(move || id.into())
                    .occlude()
                    .mt(px(32.))
                    .w(px(width))
                    .p(px(6.))
                    .rounded(px(10.))
                    .bg(crate::theme::popover_background())
                    .border_1()
                    .border_color(theme().border)
                    .shadow_lg()
                    .child(body),
            ),
    )
    .with_priority(2)
    .into_any_element()
}

impl Render for GitActions {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let idle = self.busy.is_none();
        let can_pr = idle && can_open_pull_request(self.branch.as_deref());
        let message = !self.input.read(cx).text.trim().is_empty();
        let mut actions = div()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && (this.menu || this.composing) {
                    this.close(cx);
                    cx.stop_propagation();
                }
            }))
            .relative()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                div()
                    .h(px(24.))
                    .flex()
                    .rounded(px(7.))
                    .border_1()
                    .border_color(theme().border)
                    .overflow_hidden()
                    .child(
                        face(
                            "review-commit",
                            if self.busy == Some(Busy::Committing) {
                                "Committing…"
                            } else {
                                "Commit"
                            },
                            idle,
                        )
                        .when(self.composing, |face| face.bg(theme().hover))
                        .on_click(cx.listener(|this, _, window, cx| {
                            if this.busy.is_none() {
                                this.open_composer(window, cx);
                            }
                        })),
                    )
                    .child(
                        face("review-git-more", "▾", idle)
                            .border_l_1()
                            .border_color(theme().border)
                            .when(self.menu, |face| face.bg(theme().hover))
                            .on_click(cx.listener(|this, _, window, cx| {
                                if this.busy.is_none() {
                                    this.menu = !this.menu;
                                    this.composing = false;
                                    // Escape reaches the menu from here.
                                    this.focus.focus(window);
                                    cx.notify();
                                }
                            })),
                    ),
            )
            .child(
                div()
                    .h(px(24.))
                    .rounded(px(7.))
                    .border_1()
                    .border_color(theme().border)
                    .overflow_hidden()
                    .child(
                        face(
                            "review-open-pr",
                            if self.busy == Some(Busy::Pushing) {
                                "Pushing…"
                            } else {
                                "Open pull request"
                            },
                            can_pr,
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.open_pull_request(cx))),
                    ),
            );
        if self.menu || self.composing {
            // A click outside closes the menu or the message box.
            actions = actions.child(
                deferred(
                    anchored().position(point(px(0.), px(0.))).child(
                        div()
                            .id("review-git-backdrop")
                            .w(px(100_000.))
                            .h(px(100_000.))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|this, _, _, cx| this.close(cx)),
                            ),
                    ),
                )
                .with_priority(1),
            );
        }
        if self.menu {
            actions = actions.child(popover(
                "review-git-menu",
                152.,
                div()
                    .child(row("review-git-commit", "Commit").on_click(cx.listener(
                        |this, _, window, cx| {
                            this.menu = false;
                            this.open_composer(window, cx);
                        },
                    )))
                    .child(
                        row("review-git-push", "Push")
                            .on_click(cx.listener(|this, _, _, cx| this.push(cx))),
                    ),
            ));
        }
        if self.composing {
            actions = actions.child(popover(
                "review-commit-box",
                300.,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .p(px(4.))
                    .child(
                        div()
                            .id("review-commit-input")
                            .debug_selector(|| "review-commit-input".into())
                            .min_h(px(60.))
                            .px(px(8.))
                            .py(px(6.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(theme().border)
                            .text_size(px(12.))
                            .child(self.input.clone()),
                    )
                    .when_some(self.error.clone(), |body, error| {
                        body.child(
                            div()
                                .debug_selector(|| "review-commit-error".into())
                                .text_size(px(11.))
                                .text_color(theme().danger)
                                .child(error),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(6.))
                            .child(
                                div()
                                    .h(px(26.))
                                    .rounded(px(7.))
                                    .border_1()
                                    .border_color(theme().border)
                                    .overflow_hidden()
                                    .child(face("review-commit-cancel", "Cancel", true).on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.composing = false;
                                            this.error = None;
                                            cx.notify();
                                        }),
                                    )),
                            )
                            .child(
                                div()
                                    .h(px(26.))
                                    .rounded(px(7.))
                                    .overflow_hidden()
                                    .bg(if message && idle {
                                        theme().accent
                                    } else {
                                        theme().border
                                    })
                                    .child(
                                        face(
                                            "review-commit-submit",
                                            if idle { "Commit" } else { "Committing…" },
                                            message && idle,
                                        )
                                        .text_color(gpui::white())
                                        .on_click(cx.listener(|this, _, _, cx| this.commit(cx))),
                                    ),
                            ),
                    ),
            ));
        }
        if let Some((text, failed)) = self.toast.clone() {
            actions = actions.child(
                deferred(
                    anchored()
                        .anchor(Corner::TopRight)
                        .snap_to_window_with_margin(px(12.))
                        .child(
                            div()
                                .debug_selector(|| "review-git-toast".into())
                                .mt(px(32.))
                                .max_w(px(320.))
                                .px(px(10.))
                                .py(px(7.))
                                .rounded(px(8.))
                                .bg(crate::theme::popover_background())
                                .border_1()
                                .border_color(if failed {
                                    theme().danger
                                } else {
                                    theme().border
                                })
                                .shadow_lg()
                                .text_size(px(11.5))
                                .text_color(if failed { theme().danger } else { theme().text })
                                .child(text),
                        ),
                )
                .with_priority(2),
            );
        }
        actions
    }
}

#[cfg(test)]
#[path = "diff_git_tests.rs"]
mod tests;
