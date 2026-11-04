//! Native menu presentation, shared by the composer controls.
use super::*;
use crate::composer::mention::{MentionResult, groups, thread_matches};
use gpui::{AnyElement, FontWeight, SharedString, StatefulInteractiveElement};
impl Surface {
    pub(super) fn slash_menu(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.composer.read(cx).controls.open.is_some() {
            return None;
        }
        let commands = self.composer.read(cx).slash_suggestions();
        if commands.is_empty() {
            return None;
        }
        let selected = self
            .composer
            .read(cx)
            .controls
            .slash
            .index
            .min(commands.len() - 1);
        let scroll = self.composer.read(cx).controls.slash.scroll.clone();
        let bounds = self.composer.read(cx).controls.context.card_bounds?;
        let mut menu = panel_content(
            "composer-slash-menu",
            (f32::from(bounds.size.width) - 16.).min(520.),
        )
        .child(small("Slash commands"));
        let mut list = div()
            .id("composer-slash-list")
            .max_h(px(292.))
            .overflow_y_scroll()
            .track_scroll(&scroll)
            .flex()
            .flex_col()
            .gap(px(2.));
        for (index, command) in commands.into_iter().enumerate() {
            list = list.child(
                div()
                    .id(SharedString::from(format!(
                        "slash-{}",
                        command.command.trim_start_matches('/')
                    )))
                    .debug_selector(move || {
                        format!("slash-{}", command.command.trim_start_matches('/'))
                    })
                    .px(px(8.))
                    .py(px(7.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .when(index == selected, |v| v.bg(theme().selection))
                    .hover(|v| v.bg(theme().hover))
                    .on_click(cx.listener(move |s, _, w, cx| {
                        s.composer
                            .update(cx, |i, cx| i.apply_slash(command, true, w, cx));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(12.5))
                                    .font_weight(FontWeight(300.))
                                    .child(command.command),
                            )
                            .child(small(command.group)),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .child(format!("{} · {}", command.title, command.description)),
                    ),
            );
        }
        menu = menu
            .child(list)
            .on_mouse_down_out(cx.listener(|s, _, _, cx| {
                s.composer.update(cx, |i, cx| {
                    i.controls.slash.dismissed = Some(i.text.clone());
                    cx.notify();
                });
                cx.notify();
            }));
        let _ = window;
        Some(
            gpui::anchored()
                .position(point(bounds.left() + px(8.), bounds.top() - px(6.)))
                .anchor(gpui::Corner::BottomLeft)
                .child(menu)
                .into_any_element(),
        )
    }
    /// Threads, agents, worktrees, scripts, terminals and files matching the
    /// composer's `@` word, newest word wins.
    pub(crate) fn search_mentions(&mut self, cx: &mut Context<Self>) {
        let editor = self.composer.clone();
        let Some(query) = editor.read(cx).controls.mention.query.clone() else {
            return;
        };
        let shell = {
            let input = editor.read(cx);
            crate::composer::shell::token(&input.text, input.cursor()).map(|(.., command)| command)
        };
        if let Some(command) = shell {
            return self.search_shell(query, command, cx);
        }
        let repo = self
            .selected
            .as_ref()
            .and_then(|id| self.sessions.iter().find(|s| s.id == *id))
            .and_then(|s| s.repo_path.clone());
        let mut results: Vec<_> = thread_matches(
            &self.sessions,
            self.selected.as_deref().unwrap_or(""),
            &query,
        )
        .into_iter()
        .map(|s| MentionResult::Thread {
            id: s.id,
            title: s.title,
            status: s.status,
        })
        .collect();
        // The lane roster the transcript's roster card reads.
        let agents = self
            .subagents
            .as_ref()
            .map(|view| view.read(cx).agents.clone())
            .unwrap_or_default();
        let terminals = crate::terminal::open_sessions();
        let sources = editor
            .read(cx)
            .controls
            .mention
            .sources
            .clone()
            .filter(|(project, ..)| repo.as_ref() == Some(project));
        results.extend(
            groups::agent_matches(&agents, &query)
                .into_iter()
                .chain(sources.iter().flat_map(|(_, trees, package)| {
                    groups::worktree_matches(trees, &query)
                        .into_iter()
                        .chain(groups::script_matches(package, &query))
                }))
                .chain(groups::terminal_matches(&terminals, &query))
                .map(MentionResult::Object),
        );
        sort_mentions(&mut results);
        editor.update(cx, |i, cx| {
            i.controls.mention.search = None;
            i.controls.mention.results = results;
            i.controls.mention.index = 0;
            cx.emit(crate::composer::commands::Changed(false));
            cx.notify();
        });
        let Some(repo) = repo else {
            return;
        };
        let client = self.client.clone();
        let task = cx.spawn(async move |_, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(80))
                .await;
            let word = query.clone();
            let (files, project) = (client.clone(), repo.clone());
            let body = cx.background_executor().spawn(async move {
                let (key, value) = if word.is_empty() {
                    ("directory", ".")
                } else {
                    ("search", word.as_str())
                };
                files.get::<Value>(
                    "/api/panel/files",
                    &[("workspace", project.as_str()), (key, value)],
                )
            });
            // Worktrees and scripts are read once while the menu is open.
            let read = sources.is_none().then(|| {
                cx.background_executor().spawn(async move {
                    let trees = client
                        .get::<Value>(
                            "/api/review/workspace",
                            &[("workspace", repo.as_str()), ("changesOnly", "1")],
                        )
                        .unwrap_or_default();
                    let package = crate::files_panel::read_file(&client, &repo, "package.json")
                        .unwrap_or_default();
                    (repo, trees, package)
                })
            });
            let files = mention_files(&body.await.unwrap_or_default(), &query);
            let read = match read {
                Some(task) => Some(task.await),
                None => None,
            };
            let _ = editor.update(cx, |i, cx| {
                if i.controls.mention.query.as_ref() != Some(&query) {
                    return;
                }
                let results = &mut i.controls.mention.results;
                if let Some((_, trees, package)) = &read {
                    results.extend(
                        groups::worktree_matches(trees, &query)
                            .into_iter()
                            .chain(groups::script_matches(package, &query))
                            .map(MentionResult::Object),
                    );
                }
                results.extend(files.into_iter().map(MentionResult::File));
                sort_mentions(results);
                if read.is_some() {
                    i.controls.mention.sources = read;
                }
                cx.emit(crate::composer::commands::Changed(false));
                cx.notify();
            });
        });
        self.composer
            .update(cx, |i, _| i.controls.mention.search = Some(task));
    }
    /// A `!` line's command word, from this computer's PATH, or a path in
    /// the project's folder, read through the files route. Both are read on
    /// the background executor and capped.
    fn search_shell(&mut self, query: String, command: bool, cx: &mut Context<Self>) {
        use crate::composer::shell;
        let editor = self.composer.clone();
        editor.update(cx, |i, cx| {
            i.controls.mention.search = None;
            i.controls.mention.results.clear();
            i.controls.mention.index = 0;
            cx.emit(crate::composer::commands::Changed(false));
            cx.notify();
        });
        let repo = self
            .selected
            .as_ref()
            .and_then(|id| self.sessions.iter().find(|s| s.id == *id))
            .and_then(|s| s.repo_path.clone());
        if !command && repo.is_none() {
            return;
        }
        let client = self.client.clone();
        let task = cx.spawn(async move |_, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(80))
                .await;
            let word = query.clone();
            let results = cx
                .background_executor()
                .spawn(async move {
                    if command {
                        return shell::command_matches(shell::executables(), &word)
                            .into_iter()
                            .map(MentionResult::Command)
                            .collect::<Vec<_>>();
                    }
                    let (folder, name) = shell::split_path(&word);
                    let directory = if folder.is_empty() { "." } else { folder };
                    let body = client.get::<Value>(
                        "/api/panel/files",
                        &[
                            ("workspace", repo.as_deref().unwrap_or_default()),
                            ("directory", directory),
                        ],
                    );
                    shell::path_matches(&body.unwrap_or_default(), folder, name)
                        .into_iter()
                        .map(|(path, directory)| MentionResult::Path { path, directory })
                        .collect()
                })
                .await;
            let _ = editor.update(cx, |i, cx| {
                if i.controls.mention.query.as_ref() == Some(&query) {
                    i.controls.mention.results = results;
                    cx.emit(crate::composer::commands::Changed(false));
                    cx.notify();
                }
            });
        });
        self.composer
            .update(cx, |i, _| i.controls.mention.search = Some(task));
    }
    pub(super) fn mention_menu(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let editor = self.composer.read(cx);
        if editor.controls.open.is_some() {
            return None;
        }
        let results = editor.mention_suggestions().to_vec();
        if results.is_empty() {
            return None;
        }
        let selected = editor.controls.mention.index.min(results.len() - 1);
        let scroll = editor.controls.mention.scroll.clone();
        let bounds = editor.controls.context.card_bounds?;
        let mut list = div()
            .id("composer-mention-list")
            .max_h(px(292.))
            .overflow_y_scroll()
            .track_scroll(&scroll)
            .flex()
            .flex_col()
            .gap(px(2.));
        let mut previous = None;
        for (index, target) in results.into_iter().enumerate() {
            let group = target.group();
            if previous != Some(group) {
                let id = match group {
                    "Threads" => "mention-group-threads",
                    "Agents" => "mention-group-agents",
                    "Worktrees" => "mention-group-worktrees",
                    "Scripts & terminals" => "mention-group-scripts",
                    "Commands" => "mention-group-commands",
                    "Paths" => "mention-group-paths",
                    _ => "mention-group-files",
                };
                list = list.child(
                    div()
                        .id(id)
                        .debug_selector(move || id.into())
                        .px(px(8.))
                        .child(small(group)),
                );
                previous = Some(group);
            }
            let thread = matches!(
                &target,
                MentionResult::Thread { .. } | MentionResult::Object(_)
            );
            let (name, detail) = match &target {
                MentionResult::File(path) => (
                    path.rsplit('/').next().unwrap_or(path).to_owned(),
                    path.clone(),
                ),
                MentionResult::Thread { title, status, .. } => (title.clone(), status.clone()),
                MentionResult::Object(object) => (object.label().to_owned(), object.detail()),
                MentionResult::Command(name) => (name.clone(), String::new()),
                MentionResult::Path { path, directory } => {
                    let name = path.rsplit('/').next().unwrap_or(path);
                    let slash = if *directory { "/" } else { "" };
                    (format!("{name}{slash}"), format!("{path}{slash}"))
                }
            };
            list = list.child(
                div()
                    .id(SharedString::from(format!("mention-{index}")))
                    .debug_selector(move || format!("mention-{index}"))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .px(px(8.))
                    .py(px(6.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .when(index == selected, |v| v.bg(theme().selection))
                    .hover(|v| v.bg(theme().hover))
                    .on_click(cx.listener(move |s, _, w, cx| {
                        s.composer
                            .update(cx, |i, cx| i.apply_mention(&target, w, cx));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .when(!thread, |v| v.flex_shrink_0())
                            .when(thread, |v| v.min_w_0().flex_1().truncate())
                            .text_size(px(12.5))
                            .font_weight(FontWeight(300.))
                            .child(crate::text::sanitize(&name)),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .child(crate::text::sanitize(&detail)),
                    ),
            );
        }
        let menu = panel_content(
            "composer-mention-menu",
            (f32::from(bounds.size.width) - 16.).min(520.),
        )
        .child(list)
        .on_mouse_down_out(cx.listener(|s, _, _, cx| {
            s.composer.update(cx, |i, cx| i.dismiss_mention(cx));
            cx.notify();
        }));
        Some(
            gpui::anchored()
                .position(point(bounds.left() + px(8.), bounds.top() - px(6.)))
                .anchor(gpui::Corner::BottomLeft)
                .child(menu)
                .into_any_element(),
        )
    }
    pub(super) fn prompt_popover(
        &mut self,
        open: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let title = match open {
            "quick" => "Quick actions",
            "prompts" => "Saved prompts",
            "repo" => "Repository",
            "branch" => "Base branch",
            "branch-create" => "Create branch",
            "rules" => "Session rules",
            "result" => "Command result",
            _ => "Save prompt",
        };
        let mut menu = panel("composer-prompt-picker", 460.).child(
            div()
                .flex()
                .justify_between()
                .child(small(title))
                .child(self.composer_button(
                    "composer-prompt-close",
                    "Close",
                    true,
                    cx,
                    |s, w, cx| s.close_composer_picker(w, cx),
                )),
        );
        if matches!(open, "save-prompt" | "branch-create") {
            menu = menu.child(self.prompt_form(open, cx));
        } else if open == "result" {
            menu = menu.child(
                div()
                    .id("composer-command-result-text")
                    .max_h(px(280.))
                    .overflow_y_scroll()
                    .text_size(px(12.))
                    .child(self.composer.read(cx).controls.prompt.feedback.clone()),
            );
        } else if open == "rules" {
            menu = menu.child(self.rules_view(cx));
        } else {
            if let Some(query) = self.composer.read(cx).controls.prompt.query.clone() {
                menu = menu.child(
                    div()
                        .id("composer-command-query")
                        .debug_selector(|| "composer-command-query".into())
                        .child(query),
                );
            }
            let state = &self.composer.read(cx).controls.prompt;
            let error = state.error.clone();
            let loading = state.loading;
            let selected = state.selected;
            if loading {
                menu = menu.child(small("Loading…"));
            } else if !error.is_empty() {
                menu = menu.child(small(error)).child(self.composer_button(
                    "composer-prompt-retry",
                    "Retry",
                    true,
                    cx,
                    move |s, _, cx| s.load_prompt_rows(open, cx),
                ));
            } else {
                let items = self.prompt_items(open, cx);
                if items.is_empty() {
                    menu = menu.child(small(match open {
                        "prompts" => "No matching prompts. Add one in Customize.",
                        "repo" => "No repositories in the registry.",
                        _ => "No matches.",
                    }));
                }
                let scroll = self.composer.read(cx).controls.prompt.scroll.clone();
                let mut list = div()
                    .id("composer-prompt-list")
                    .track_scroll(&scroll)
                    .max_h(px(280.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(2.));
                for (index, item) in items.into_iter().enumerate() {
                    let chosen = match open {
                        "repo" => self.intent_repo(cx).as_deref() == Some(item.0.as_str()),
                        "branch" => self.composer.read(cx).controls.prompt.branch == item.0,
                        _ => index == selected,
                    };
                    let pick = item.clone();
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("composer-prompt-item-{index}")))
                            .debug_selector(move || format!("composer-prompt-item-{index}"))
                            .p(px(8.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .when(chosen, |v| v.bg(theme().selection))
                            .hover(|v| v.bg(theme().hover))
                            .on_click(cx.listener(move |s, _, w, cx| {
                                s.pick_prompt_item(open, pick.clone(), w, cx)
                            }))
                            .child(div().text_size(px(12.5)).child(item.1))
                            .child(
                                div()
                                    .text_size(px(10.5))
                                    .text_color(theme().text_secondary)
                                    .truncate()
                                    .child(item.2),
                            ),
                    );
                }
                menu = menu.child(list);
                if open == "branch" {
                    menu = menu.child(self.composer_button(
                        "composer-branch-new",
                        "New branch",
                        true,
                        cx,
                        |s, w, cx| s.open_prompt("branch-create", w, cx),
                    ));
                }
            }
        }
        let opened = self.composer.read(cx).controls.prompt.opened;
        if let Some(at) = opened {
            let progress = (cx
                .background_executor()
                .now()
                .saturating_duration_since(at)
                .as_secs_f32()
                * 1000.
                / crate::motion::COMPOSER_MENU_ENTER_MS as f32)
                .min(1.);
            if progress < 1. {
                window.request_animation_frame();
            }
            menu = menu.opacity(crate::motion::ease_out(progress));
        }
        menu.on_mouse_down_out(
            cx.listener(|s, event: &gpui::MouseDownEvent, _, cx| {
                s.dismiss_prompt_outside(event, cx)
            }),
        )
        .into_any_element()
    }
    fn prompt_form(&self, open: &str, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.composer.read(cx).controls.prompt;
        let fields = state.fields.clone();
        let error = state.error.clone();
        let result = state.result.clone();
        let repo_scope = state.scope;
        let busy = state.loading;
        let mut form = div().flex().flex_col().gap(px(8.));
        for (index, field) in fields.iter().enumerate() {
            form = form
                .child(small(if open == "branch-create" {
                    "Branch name"
                } else {
                    ["Title", "Tags (comma separated)", "Prompt"][index]
                }))
                .child(
                    div()
                        .id(SharedString::from(format!("composer-prompt-field-{index}")))
                        .debug_selector(move || format!("composer-prompt-field-{index}"))
                        .max_h(px(160.))
                        .overflow_y_scroll()
                        .child(field.clone()),
                );
        }
        if open == "save-prompt" {
            form = form.child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(self.composer_button(
                        "composer-prompt-global",
                        if !repo_scope { "✓ Global" } else { "Global" },
                        !busy,
                        cx,
                        |s, _, cx| {
                            s.composer.update(cx, |i, cx| {
                                i.controls.prompt.scope = false;
                                cx.notify();
                            });
                            cx.notify();
                        },
                    ))
                    .child(self.composer_button(
                        "composer-prompt-repo",
                        if repo_scope {
                            "✓ Repository"
                        } else {
                            "Repository"
                        },
                        !busy && self.intent_repo(cx).is_some(),
                        cx,
                        |s, _, cx| {
                            s.composer.update(cx, |i, cx| {
                                i.controls.prompt.scope = true;
                                cx.notify();
                            });
                            cx.notify();
                        },
                    )),
            );
        }
        if !error.is_empty() {
            form = form.child(small(error));
        }
        if !result.is_empty() {
            form = form.child(small(result));
        }
        form.child(self.composer_button(
            "composer-prompt-submit",
            if busy {
                "Saving…"
            } else if open == "branch-create" {
                "Create branch"
            } else {
                "Save prompt"
            },
            !busy,
            cx,
            |s, _, cx| s.submit_prompt_form(cx),
        ))
        .into_any_element()
    }
}
/// Threads, then agents, worktrees, scripts and terminals, then files; each
/// group keeps its own order.
fn sort_mentions(results: &mut [MentionResult]) {
    results.sort_by_key(|result| match result.group() {
        "Threads" => 0,
        "Agents" => 1,
        "Worktrees" => 2,
        "Scripts & terminals" => 3,
        _ => 4,
    });
}
/// The files in a listing: names starting with the word first, then the
/// shortest paths, so `package.json` at the root beats one buried in a folder.
fn mention_files(body: &Value, word: &str) -> Vec<String> {
    const LIMIT: usize = 12;
    let word = word.to_lowercase();
    let mut files: Vec<String> = body["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["kind"] != "directory" && entry["type"] != "directory")
        .filter_map(|entry| entry["path"].as_str().map(str::to_owned))
        .collect();
    files.sort_by_key(|path| {
        let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
        (!name.starts_with(&word), path.len())
    });
    files.truncate(LIMIT);
    files
}
#[cfg(test)]
#[test]
fn a_file_named_like_the_word_comes_first_and_folders_never_do() {
    let body = serde_json::json!({"entries":[
        {"path":"cli/deep/package.json"},
        {"path":"src/backpack.ts"},
        {"path":"package.json"},
        {"path":"packages","kind":"directory"},
    ]});
    assert_eq!(
        mention_files(&body, "pack"),
        ["package.json", "cli/deep/package.json", "src/backpack.ts"]
    );
}
pub(super) fn small(text: impl Into<SharedString>) -> impl IntoElement {
    div()
        .text_size(px(10.5))
        .text_color(theme().text_secondary)
        .child(text.into())
}
fn panel_content(id: &'static str, width: f32) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .w(px(width))
        .p(px(8.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .rounded(px(14.))
        .border_1()
        .border_color(theme().border)
        .bg(crate::theme::popover_background())
        .shadow_lg()
        .occlude()
}
fn panel(id: &'static str, width: f32) -> gpui::Stateful<gpui::Div> {
    panel_content(id, width)
        .absolute()
        .bottom_full()
        .left(px(8.))
        .mb(px(8.))
        .max_w(gpui::relative(1.))
}
