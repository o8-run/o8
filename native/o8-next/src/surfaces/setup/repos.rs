//! The desktop's project step (OnboardingReposStep.tsx): choose a folder on
//! this Mac, reopen a project already in o8, or clone one from GitHub.
//! Setup never signs in to GitHub. It asks the server whether GitHub is
//! connected, lists and clones through the server's own routes, and when
//! GitHub is not connected it says so and points to Settings.
use super::look::{self, Look};
use super::{Action, Project, Setup, Step, primary, quiet};
use crate::client::Client;
use crate::theme::current as theme;
use gpui::{AnyElement, Context, Div, FontWeight, Rgba, div, prelude::*, px, relative};
use serde::Deserialize;
use std::{sync::LazyLock, time::Instant};

/// The spinners turn from one shared start, as the update panel's does.
static SPIN: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Shown for any failed clone. The server's own text never reaches the page.
pub(super) const CLONE_FAILED: &str =
    "Couldn’t clone this project. Try again, or choose a folder on this Mac.";
const LIST_FAILED: &str =
    "Couldn’t load your GitHub repositories. Check your connection and retry.";
const FOLDER: &str = "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z";
const INFO: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01";
const CHECK: &str = "M20 6L9 17l-5-5";
const RING: &str = "M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18";
const ARC: &str = "M12 3a9 9 0 0 1 9 9";

/// One repository from `/api/panel/repos?source=github`, in GitHub's shape.
#[derive(Clone, Deserialize)]
pub(super) struct GithubRepo {
    full_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    clone_url: String,
}

/// A row's clone progress.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Row {
    Cloning,
    Done,
    Failed,
}

/// The step's own state; local projects come from setup's snapshot.
#[derive(Default)]
pub(super) struct Repos {
    show_github: bool,
    /// None until the server answers.
    authenticated: Option<bool>,
    github: Vec<GithubRepo>,
    loading: bool,
    list_failed: bool,
    selected: Option<String>,
    pub(super) status: Option<(String, Row)>,
    generation: u64,
    /// The folder page was opened from this step and returns to it.
    pub(super) folder_return: bool,
}

/// A local project and a GitHub repository share one row and one selection.
struct Item {
    key: String,
    title: String,
    subtitle: Option<String>,
    language: Option<String>,
    private: bool,
    project: Option<Project>,
    clone: Option<(String, String)>,
}

/// Whether GitHub is connected and, if so, its repositories. Err means the
/// list did not load.
fn load(client: &Client) -> Result<(bool, Vec<GithubRepo>), ()> {
    #[derive(Deserialize)]
    struct Status {
        #[serde(default)]
        authenticated: bool,
    }
    #[derive(Deserialize)]
    struct List {
        #[serde(default)]
        repos: Vec<GithubRepo>,
    }
    // As on the desktop, a refused status reads as not connected.
    let connected = client
        .get::<Status>("/api/panel/github-status", &[])
        .is_ok_and(|status| status.authenticated);
    if !connected {
        return Ok((false, vec![]));
    }
    let list = client
        .get::<List>("/api/panel/repos", &[("source", "github"), ("limit", "50")])
        .map_err(|_| ())?;
    Ok((true, list.repos))
}

/// The desktop's spinner: a faint ring with a turning accent arc.
fn spinner(size: f32) -> Div {
    let turn = SPIN.elapsed().as_secs_f32();
    div()
        .relative()
        .size(px(size))
        .flex_none()
        .child(
            div()
                .absolute()
                .child(crate::icon::stroke(RING, theme().text_faint, size, 2.)),
        )
        .child(div().absolute().child(
            crate::icon::stroke(ARC, theme().accent, size, 2.).with_transformation(
                gpui::Transformation::rotate(gpui::radians(turn.fract() * std::f32::consts::TAU)),
            ),
        ))
}

fn soft(color: Rgba, alpha: f32) -> Rgba {
    Rgba { a: alpha, ..color }
}

fn pill(selector: String, text: &'static str, background: Rgba, color: Rgba) -> Div {
    div()
        .debug_selector(move || selector.clone())
        .px(px(6.))
        .py(px(2.))
        .rounded_full()
        .bg(background)
        .text_size(px(9.))
        .font_weight(FontWeight::LIGHT)
        .text_color(color)
        .child(text)
}

impl Setup {
    /// Home's Clone from GitHub: this step with the GitHub list open.
    pub(super) fn open_repos(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.repos.show_github = true;
        self.repos.status = None;
        self.repos.selected = self.project.as_ref().map(|p| p.local_path.clone());
        self.navigate(Step::Repos, cx);
        self.load_github(cx);
    }
    /// Ask the server whether GitHub is connected, then list its repositories.
    pub(super) fn load_github(&mut self, cx: &mut Context<Self>) {
        self.repos.generation += 1;
        let generation = self.repos.generation;
        self.repos.loading = true;
        self.repos.list_failed = false;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move { load(&client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.repos.generation != generation {
                    return;
                }
                this.repos.loading = false;
                match result {
                    Ok((connected, list)) => {
                        this.repos.authenticated = Some(connected);
                        this.repos.github = list;
                    }
                    Err(()) => {
                        this.repos.authenticated = Some(true);
                        this.repos.list_failed = true;
                    }
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        self.revision += 1;
        cx.notify();
    }
    fn toggle_github(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.repos.show_github = !self.repos.show_github;
        if self.repos.show_github {
            self.load_github(cx);
        } else {
            self.repos.generation += 1;
            self.repos.loading = false;
            self.repos.list_failed = false;
            self.revision += 1;
            cx.notify();
        }
    }
    /// The folder page, returning here with the new folder selected.
    fn repos_folder(&mut self, window: &mut gpui::Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.repos.folder_return = true;
        self.navigate(Step::Folder, cx);
        self.folder.read(cx).focus.focus(window);
    }
    /// A folder added from this step comes back selected.
    pub(super) fn select_repo(&mut self, project: &Project) {
        self.repos.selected = Some(project.local_path.clone());
    }
    fn select(&mut self, key: String, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.repos.selected = Some(key);
        self.revision += 1;
        cx.notify();
    }
    /// Use this project: a local one opens; a GitHub one clones first.
    fn use_repo(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.repos.selected.clone() else {
            return;
        };
        let Some(item) = self.repo_items().into_iter().find(|item| item.key == key) else {
            return;
        };
        if let Some(project) = item.project {
            self.act(Action::Choose(Some(project)), cx);
        } else if let Some((url, name)) = item.clone {
            self.repos.status = Some((key, Row::Cloning));
            self.act(Action::Clone(url, name), cx);
        }
    }
    fn repo_items(&self) -> Vec<Item> {
        let local = self
            .snapshot
            .as_ref()
            .map(|s| s.projects.clone())
            .unwrap_or_default()
            .into_iter()
            .map(|project| Item {
                key: project.local_path.clone(),
                title: project.name.clone(),
                subtitle: Some(project.local_path.clone()),
                language: None,
                private: false,
                project: Some(project),
                clone: None,
            });
        let github = self
            .repos
            .github
            .iter()
            .filter(|_| self.repos.show_github)
            .map(|repo| Item {
                key: repo.full_name.clone(),
                title: repo.full_name.clone(),
                subtitle: repo.description.clone().filter(|d| !d.is_empty()),
                language: repo.language.clone().filter(|l| !l.is_empty()),
                private: repo.private,
                project: None,
                clone: Some((repo.clone_url.clone(), repo.name.clone())),
            });
        local.chain(github).collect()
    }

    fn repo_row(&self, index: usize, item: &Item, cx: &mut Context<Self>) -> AnyElement {
        let chosen = self.repos.selected.as_ref() == Some(&item.key);
        let status = self
            .repos
            .status
            .as_ref()
            .filter(|(key, _)| *key == item.key)
            .map(|(_, row)| *row);
        let key = item.key.clone();
        look::button(&format!("setup-repo-{index}"), "", !self.busy, Look::Quiet)
            // Rows stay at full strength while a clone runs, as on the desktop.
            .opacity(1.)
            .w_full()
            .min_h(px(0.))
            .py(px(10.))
            .px(px(14.))
            .border_1()
            .border_color(if chosen {
                soft(theme().accent, 0.45)
            } else {
                soft(theme().accent, 0.)
            })
            .bg(if chosen {
                soft(theme().accent, 0.12)
            } else {
                soft(theme().accent, 0.)
            })
            .text_color(theme().text)
            .child(
                div()
                    .debug_selector({
                        let id = format!("setup-repo-{index}-box");
                        move || id.clone()
                    })
                    .size(px(18.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.))
                    .border_2()
                    .border_color(if chosen {
                        theme().accent
                    } else {
                        theme().text_faint
                    })
                    .when(chosen, |v| {
                        v.bg(theme().accent).child(crate::icon::stroke(
                            CHECK,
                            crate::theme::on_accent(),
                            11.,
                            3.,
                        ))
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(13.))
                            .truncate()
                            .child(item.title.clone()),
                    )
                    .when_some(item.subtitle.clone(), |v, subtitle| {
                        v.child(
                            div()
                                .mt(px(2.))
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .truncate()
                                .child(subtitle),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.))
                    .when(status == Some(Row::Cloning), |v| {
                        v.child(
                            div()
                                .debug_selector({
                                    let id = format!("setup-repo-{index}-cloning");
                                    move || id.clone()
                                })
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .text_size(px(10.))
                                .text_color(theme().text_muted)
                                .child(spinner(11.))
                                .child("Cloning"),
                        )
                    })
                    .when(status == Some(Row::Done), |v| {
                        v.child(crate::icon::stroke(CHECK, theme().success, 14., 2.5))
                    })
                    .when(status == Some(Row::Failed), |v| {
                        v.child(
                            div()
                                .debug_selector({
                                    let id = format!("setup-repo-{index}-failed");
                                    move || id.clone()
                                })
                                .text_size(px(10.))
                                .text_color(theme().danger)
                                .child("Failed"),
                        )
                    })
                    .when(item.project.is_some(), |v| {
                        v.child(pill(
                            format!("setup-repo-{index}-local"),
                            "Local",
                            soft(theme().accent, 0.12),
                            theme().accent,
                        ))
                    })
                    .when_some(item.language.clone(), |v, language| {
                        v.child(
                            div()
                                .text_size(px(10.))
                                .text_color(theme().text_faint)
                                .child(language),
                        )
                    })
                    .when(item.private, |v| {
                        v.child(pill(
                            format!("setup-repo-{index}-private"),
                            "Private",
                            theme().border,
                            theme().text_muted,
                        ))
                    }),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.select(key.clone(), cx)))
            .into_any_element()
    }

    /// Choose a project: a folder, a project in o8, or a GitHub repository.
    pub(super) fn repos_page(&self, window: &mut gpui::Window, cx: &mut Context<Self>) -> Div {
        let busy = self.busy;
        let r = &self.repos;
        let items = self.repo_items();
        let query = self.repo_search.read(cx).text.trim().to_lowercase();
        let shown: Vec<(usize, &Item)> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                query.is_empty()
                    || item.title.to_lowercase().contains(&query)
                    || item
                        .subtitle
                        .as_ref()
                        .is_some_and(|s| s.to_lowercase().contains(&query))
            })
            .collect();
        let cloning = busy
            && r.status
                .as_ref()
                .is_some_and(|(_, row)| *row == Row::Cloning);
        if r.loading || cloning {
            window.request_animation_frame();
        }
        let chosen = r
            .selected
            .as_ref()
            .is_some_and(|key| items.iter().any(|item| &item.key == key));
        let error = if r.list_failed {
            Some((LIST_FAILED.to_owned(), true))
        } else {
            self.error.clone().map(|error| (error, false))
        };
        let rows: Vec<AnyElement> = shown
            .iter()
            .map(|(index, item)| self.repo_row(*index, item, cx))
            .collect();
        let mut body = div().flex().flex_col().gap(px(16.));
        if r.loading {
            body = body.child(
                div()
                    .debug_selector(|| "setup-repos-loading".into())
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(10.))
                    .p(px(24.))
                    .text_size(px(13.))
                    .text_color(theme().text_secondary)
                    .child(spinner(14.))
                    .child("Checking GitHub & loading your repositories…"),
            );
        } else {
            body = body
                .when(r.show_github && r.authenticated == Some(false), |v| {
                    v.child(
                        div()
                            .debug_selector(|| "setup-github-signed-out".into())
                            .flex()
                            .items_start()
                            .gap(px(10.))
                            .py(px(16.))
                            .px(px(18.))
                            .rounded(px(12.))
                            .border_1()
                            .border_color(theme().border)
                            .bg(crate::theme::glass_muted())
                            .child(div().mt(px(1.)).child(crate::icon::stroke(
                                INFO,
                                theme().text_secondary,
                                18.,
                                1.8,
                            )))
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(12.5))
                                    .line_height(relative(1.5))
                                    .text_color(theme().text_secondary)
                                    .child(
                                        "GitHub isn’t connected on this machine yet. Choose a \
                                         local folder, or connect GitHub later in Settings.",
                                    ),
                            ),
                    )
                })
                .when_some(error, |v, (error, retry)| {
                    v.child(
                        div()
                            .debug_selector(|| "setup-repos-error".into())
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .py(px(14.))
                            .px(px(16.))
                            .rounded(px(12.))
                            .border_1()
                            .border_color(theme().danger)
                            .bg(crate::theme::glass_muted())
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(12.5))
                                    .line_height(relative(1.5))
                                    .text_color(theme().text_secondary)
                                    .child(error),
                            )
                            .when(retry, |v| {
                                v.child(
                                    look::button(
                                        "setup-repos-retry",
                                        "Retry",
                                        !busy,
                                        Look::Bordered,
                                    )
                                    .min_h(px(36.))
                                    .py(px(8.))
                                    .text_size(px(12.5))
                                    .flex_none()
                                    .on_click(cx.listener(|this, _, _, cx| this.load_github(cx))),
                                )
                            }),
                    )
                })
                .when(!items.is_empty(), |v| {
                    v.child(
                        div()
                            .debug_selector(|| "setup-repos-search".into())
                            .child(self.repo_search.clone()),
                    )
                })
                .when(
                    items.is_empty() && !r.list_failed && self.error.is_none(),
                    |v| {
                        v.child(
                            div()
                                .debug_selector(|| "setup-repos-empty".into())
                                .p(px(20.))
                                .flex()
                                .justify_center()
                                .text_size(px(13.))
                                .line_height(relative(1.5))
                                .text_color(theme().text_muted)
                                .child(if r.authenticated != Some(true) {
                                    "Add a local repository folder to get started."
                                } else {
                                    "No repos found on your GitHub account. Use “Choose a folder \
                                 on this Mac” above, or add repos later from Projects."
                                }),
                        )
                    },
                )
                .when(!items.is_empty(), |v| {
                    v.child(
                        div()
                            .id("setup-repo-list")
                            .debug_selector(|| "setup-repo-list".into())
                            .max_h(px(300.))
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .pr(px(4.))
                            .when(rows.is_empty(), |v| {
                                v.child(
                                    div()
                                        .debug_selector(|| "setup-repos-no-match".into())
                                        .p(px(20.))
                                        .flex()
                                        .justify_center()
                                        .text_size(px(13.))
                                        .text_color(theme().text_muted)
                                        .child("No repos match your search."),
                                )
                            })
                            .children(rows),
                    )
                });
        }
        div()
            .debug_selector(|| "setup-repos".into())
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(look::title("Choose a project"))
            .child(
                div()
                    .text_size(px(13.))
                    .line_height(relative(1.6))
                    .text_color(theme().text_secondary)
                    .child(
                        "Start with one project. Choose a folder or reopen a project already \
                         in o8. You can add more later.",
                    ),
            )
            .child(
                div().flex().child(
                    look::button("setup-repos-folder", "", !busy, Look::Bordered)
                        .justify_center()
                        .gap(px(10.))
                        .child(crate::icon::stroke(FOLDER, theme().text, 16., 1.8))
                        .child("Choose a folder on this Mac")
                        .on_click(cx.listener(|this, _, window, cx| this.repos_folder(window, cx))),
                ),
            )
            .child(
                div().flex().child(
                    look::button(
                        "setup-repos-github",
                        if r.show_github {
                            "Hide GitHub projects"
                        } else {
                            "Clone from GitHub (optional)"
                        },
                        !busy,
                        Look::Bordered,
                    )
                    .text_size(px(12.))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_github(cx))),
                ),
            )
            .child(body)
            .child(div().mt(px(8.)).child(look::actions(
                vec![
                        quiet("setup-repos-later", "Choose later", !busy)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.navigate(Step::Projects, cx)
                            }))
                            .into_any_element(),
                    ],
                vec![
                        primary(
                            "setup-repos-use",
                            if cloning {
                                "Cloning project…"
                            } else if r.selected.is_some() {
                                "Use this project"
                            } else {
                                "Choose a project"
                            },
                            chosen && !busy,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            if !this.busy {
                                this.use_repo(cx)
                            }
                        }))
                        .into_any_element(),
                    ],
            )))
    }
}
