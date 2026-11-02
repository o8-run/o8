//! New and edit automation (AutomationEditor.tsx, AutomationWatchFields.tsx):
//! every field the desktop form has, sent as the desktop sends it. Pickers are
//! chips with the chosen option's detail under them.
use super::cron::{Cron, Moment};
use super::view::{OWNER, Scheduled, action, call};
use super::*;
use crate::{composer::Composer, theme::current as theme};
use gpui::{Div, SharedString, WeakEntity};
use serde_json::{Value, json};

const DEFAULT_CRON: &str = "0 9 * * *";
const DEFAULT_EVENTS: &str = "review_requested, completed, failed";
type Choice = (&'static str, &'static str, &'static str);
const RUNTIMES: [Choice; 3] = [
    ("codex", "Codex", ""),
    ("gemini", "Gemini CLI", ""),
    ("opencode", "OpenCode 2", ""),
];
const TRIGGERS: [Choice; 3] = [
    ("manual", "Manual", ""),
    ("cron", "Cron", ""),
    ("watch", "Watch", ""),
];
const CATCH_UP: [Choice; 3] = [
    ("latest", "Run latest", "Run only the newest missed slot."),
    ("all", "Run all", "Keep every missed scheduled slot."),
    ("skip", "Skip missed", "Resume at the next future slot."),
];
const SOURCES: [Choice; 3] = [
    (
        "managed_run",
        "Managed run",
        "Output, exit, loss, quiet, and recovery.",
    ),
    (
        "packet",
        "Packet or mission",
        "Durable lane and packet state transitions.",
    ),
    (
        "repository",
        "Repository",
        "Pull request and check updates.",
    ),
];
const ACTIONS: [Choice; 4] = [
    ("dispatch", "Dispatch agent", ""),
    ("notify", "Notify operator", ""),
    ("steer", "Steer lane", ""),
    ("approval", "Request approval", ""),
];

/// The editor closed; carries the saved record, if any.
pub(super) struct Done(pub Option<Value>);
impl gpui::EventEmitter<Done> for Editor {}

pub(crate) struct Editor {
    owner: WeakEntity<Scheduled>,
    id: Option<String>,
    name: Entity<Composer>,
    prompt: Entity<Composer>,
    branch: Entity<Composer>,
    precheck: Entity<Composer>,
    precheck_timeout: Entity<Composer>,
    cron: Entity<Composer>,
    concurrency: Entity<Composer>,
    source_id: Entity<Composer>,
    events: Entity<Composer>,
    literal: Entity<Composer>,
    quiet: Entity<Composer>,
    target_lane: Entity<Composer>,
    min_interval: Entity<Composer>,
    batch_window: Entity<Composer>,
    max_fires: Entity<Composer>,
    repos: Vec<(String, String)>,
    repo: String,
    runtime: String,
    trigger: String,
    catch_up: String,
    source: String,
    watch_action: String,
    /// The expression the hint below was worked out for.
    hint: (String, String, bool),
    saving: bool,
    error: Option<String>,
}

/// A number field's value, clamped as the desktop's inputs clamp it.
fn number(input: &Entity<Composer>, fallback: u64, min: u64, max: u64, cx: &gpui::App) -> u64 {
    input
        .read(cx)
        .text
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value != 0)
        .unwrap_or(fallback)
        .clamp(min, max)
}

/// `Next run Mon, Nov 2, 9:00 AM`, or why there is none.
fn cron_hint(expr: &str) -> (String, bool) {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let Some(cron) = Cron::parse(expr) else {
        return (
            "Use five fields: minute, hour, day of month, month, day of week.".into(),
            false,
        );
    };
    let local = |at: u64| {
        super::super::sidebar::calendar_moment(at).map(|(month, day, weekday, hour, minute)| {
            Moment {
                month,
                day,
                weekday,
                hour,
                minute,
            }
        })
    };
    match cron.next(crate::clock::now(), local) {
        Some((_, at)) => {
            let hour = match at.hour % 12 {
                0 => 12,
                hour => hour,
            };
            (
                format!(
                    "Next run {}, {} {}, {hour}:{:02} {}",
                    DAYS[at.weekday as usize],
                    MONTHS[at.month as usize - 1],
                    at.day,
                    at.minute,
                    if at.hour < 12 { "AM" } else { "PM" },
                ),
                true,
            )
        }
        None => ("This schedule has no run in the next year.".into(), true),
    }
}

impl Editor {
    pub(super) fn new(
        owner: WeakEntity<Scheduled>,
        row: Option<Value>,
        mut repos: Vec<(String, String)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let text = |key: &str| {
            row.as_ref()
                .and_then(|r| r[key].as_str())
                .unwrap_or("")
                .to_owned()
        };
        let amount = |key: &str, fallback: u64| {
            row.as_ref()
                .and_then(|r| r[key].as_u64())
                .unwrap_or(fallback)
                .to_string()
        };
        let input = |value: String, placeholder: &str, inline: bool, cx: &mut Context<Self>| {
            let input = cx.new(|cx| {
                let mut input = Composer::new(cx);
                input.text = value;
                input.placeholder = placeholder.into();
                input.inline = inline;
                input.framed = false;
                input.newline_on_enter = !inline;
                input
            });
            cx.observe(&input, |_, _, cx| cx.notify()).detach();
            input
        };
        let or = |value: String, fallback: &str| {
            if value.is_empty() {
                fallback.to_owned()
            } else {
                value
            }
        };
        let repo = match text("repoPath") {
            path if path.is_empty() => repos.first().map(|r| r.0.clone()).unwrap_or_default(),
            path => path,
        };
        if !repo.is_empty() && !repos.iter().any(|r| r.0 == repo) {
            repos.insert(0, (repo.clone(), text("branch")));
        }
        let branch = or(
            text("branch"),
            repos
                .first()
                .map(|r| r.1.as_str())
                .filter(|b| !b.is_empty())
                .unwrap_or("main"),
        );
        let events = match row.as_ref().and_then(|r| r["watchEventTypes"].as_array()) {
            Some(types) if !types.is_empty() => types
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", "),
            _ => DEFAULT_EVENTS.to_owned(),
        };
        let name = input(text("name"), "Daily diff summary", true, cx);
        name.read(cx).focus.focus(window);
        Self {
            owner,
            id: row
                .as_ref()
                .and_then(|r| r["id"].as_str())
                .map(str::to_owned),
            prompt: input(
                text("prompt"),
                "What should the agent do each run?",
                false,
                cx,
            ),
            branch: input(branch, "", true, cx),
            precheck: input(
                text("precheckCommand"),
                "git diff --quiet origin/main...HEAD",
                true,
                cx,
            ),
            precheck_timeout: input(amount("precheckTimeoutMs", 10_000), "", true, cx),
            cron: input(or(text("cronExpr"), DEFAULT_CRON), DEFAULT_CRON, true, cx),
            concurrency: input(amount("repoConcurrencyLimit", 1), "", true, cx),
            source_id: input(
                text("watchSourceId"),
                "Packet ID, run ID, or repository name",
                true,
                cx,
            ),
            events: input(events, DEFAULT_EVENTS, true, cx),
            literal: input(text("watchLiteralFilter"), "", true, cx),
            quiet: input(amount("watchQuietMs", 60_000), "", true, cx),
            target_lane: input(text("watchTargetLaneId"), "", true, cx),
            min_interval: input(amount("watchMinIntervalMs", 0), "", true, cx),
            batch_window: input(amount("watchBatchWindowMs", 0), "", true, cx),
            max_fires: input(amount("watchMaxFiresPerTick", 4), "", true, cx),
            name,
            repos,
            repo,
            runtime: match text("runtime") {
                r if RUNTIMES.iter().any(|choice| choice.0 == r) => r,
                _ => "codex".into(),
            },
            trigger: or(text("triggerKind"), "cron"),
            catch_up: or(text("catchUpPolicy"), "latest"),
            source: or(text("watchSourceKind"), "packet"),
            watch_action: or(text("watchActionKind"), "dispatch"),
            hint: Default::default(),
            saving: false,
            error: None,
        }
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        if !self.saving {
            cx.emit(Done(None));
        }
    }

    fn choose_repo(&mut self, path: String, cx: &mut Context<Self>) {
        // A branch still on the default follows the repository (AutomationEditor).
        let default = self
            .repos
            .iter()
            .find(|repo| repo.0 == path)
            .map(|repo| repo.1.clone())
            .filter(|branch| !branch.is_empty());
        if let Some(default) = default
            && self.branch.read(cx).text == "main"
        {
            self.branch
                .update(cx, |input, cx| input.set_text(&default, cx));
        }
        self.repo = path;
        cx.notify();
    }

    /// The request body, as AutomationEditor's submit builds it.
    fn payload(&self, cx: &gpui::App) -> Value {
        let text = |input: &Entity<Composer>| input.read(cx).text.trim().to_owned();
        let optional = |input: &Entity<Composer>| match text(input) {
            value if value.is_empty() => Value::Null,
            value => json!(value),
        };
        let watch = self.trigger == "watch";
        let cron = self.trigger == "cron";
        let branch = match text(&self.branch) {
            branch if branch.is_empty() => "main".to_owned(),
            branch => branch,
        };
        let mut body = json!({
            "name": text(&self.name),
            "prompt": text(&self.prompt),
            "runtime": self.runtime,
            "repoPath": self.repo.trim(),
            "branch": branch,
            "triggerKind": self.trigger,
            "cronExpr": if cron { json!(text(&self.cron)) } else { Value::Null },
            "catchUpPolicy": self.catch_up,
            "repoConcurrencyLimit": number(&self.concurrency, 1, 1, 16, cx),
            "precheckCommand": optional(&self.precheck),
            "precheckTimeoutMs": number(&self.precheck_timeout, 10_000, 1_000, 300_000, cx),
            "watchQuietMs": if watch && self.source == "managed_run" {
                json!(number(&self.quiet, 60_000, 1_000, 86_400_000, cx))
            } else {
                Value::Null
            },
            "watchMinIntervalMs": number(&self.min_interval, 0, 0, 86_400_000, cx),
            "watchBatchWindowMs": number(&self.batch_window, 0, 0, 86_400_000, cx),
            "watchMaxFiresPerTick": number(&self.max_fires, 4, 1, 16, cx),
        });
        if watch {
            body["watchSourceKind"] = json!(self.source);
            body["watchSourceId"] = optional(&self.source_id);
            body["watchEventTypes"] = json!(
                text(&self.events)
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
            );
            body["watchLiteralFilter"] = optional(&self.literal);
            body["watchActionKind"] = json!(self.watch_action);
            body["watchTargetLaneId"] = optional(&self.target_lane);
        }
        body
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let filled = |input: &Entity<Composer>| !input.read(cx).text.trim().is_empty();
        let missing = if !filled(&self.name) {
            Some("Name is required.")
        } else if !filled(&self.prompt) {
            Some("Prompt is required.")
        } else if self.repo.trim().is_empty() {
            Some("Repo is required.")
        } else if self.trigger == "cron" && Cron::parse(&self.cron.read(cx).text).is_none() {
            Some("Enter a valid five-field cron expression.")
        } else {
            None
        };
        if let Some(missing) = missing {
            self.error = Some(missing.into());
            cx.notify();
            return;
        }
        let mut body = self.payload(cx);
        let (method, path) = match &self.id {
            Some(id) => ("PATCH", format!("/api/automations/{id}")),
            None => {
                body["owner"] = json!(OWNER);
                ("POST", "/api/automations".to_owned())
            }
        };
        let Some(client) = self.owner.upgrade().map(|o| o.read(cx).client.clone()) else {
            return;
        };
        let verb = if self.id.is_some() { "Save" } else { "Create" };
        self.saving = true;
        self.error = None;
        cx.notify();
        let task = cx
            .background_executor()
            .spawn(async move { call(&client, method, &path, Some(body)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(data) if data["automation"].is_object() => {
                        cx.emit(Done(Some(data["automation"].clone())))
                    }
                    Ok(data) => {
                        this.error = Some(
                            data["error"]
                                .as_str()
                                .map_or_else(|| format!("{verb} failed"), str::to_owned),
                        );
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

/// Field: an uppercase label over its control.
fn field(text: &'static str, control: impl IntoElement) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .min_w_0()
        .child(
            div()
                .text_size(px(10.))
                .text_color(theme().text_faint)
                .child(text.to_uppercase()),
        )
        .child(control)
}

/// Fields side by side, sharing the row evenly.
fn columns(fields: impl IntoIterator<Item = Div>) -> Div {
    div()
        .flex()
        .gap(px(12.))
        .children(fields.into_iter().map(|field| field.flex_1()))
}

fn note(text: impl Into<SharedString>, color: gpui::Rgba) -> Div {
    div()
        .text_size(px(9.5))
        .line_height(gpui::relative(1.35))
        .text_color(color)
        .child(text.into())
}

/// A bordered field; the multi-line composer brings its own padding.
fn boxed(
    id: &'static str,
    input: &Entity<Composer>,
    height: f32,
    mono: bool,
    cx: &gpui::App,
) -> Div {
    let inline = height < 40.;
    let focus = input.read(cx).focus.clone();
    div()
        .debug_selector(move || id.into())
        .cursor_text()
        .on_mouse_down(gpui::MouseButton::Left, move |_, window, _| {
            focus.focus(window);
            // Keeps the shell's own focus tracker from taking it back.
            window.prevent_default();
        })
        .min_h(px(height))
        .when(inline, |d| d.px(px(11.)).py(px(8.)))
        .rounded(px(9.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface)
        .text_size(px(12.5))
        .when(mono, |d| d.font_family(theme().font_mono))
        .child(input.clone())
}

fn chip(id: String, text: String, on: bool) -> gpui::Stateful<Div> {
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector.clone())
        .h(px(26.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(7.))
        .bg(if on { theme().hover } else { theme().surface })
        .text_size(px(12.))
        .text_color(if on { theme().text } else { theme().text_muted })
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
        .child(text)
}

/// One picker: its chips and, under them, what the chosen option does.
fn chips(
    prefix: &'static str,
    choices: &'static [Choice],
    current: &str,
    set: fn(&mut Editor, &'static str),
    cx: &mut Context<Editor>,
) -> Div {
    let detail = choices
        .iter()
        .find(|choice| choice.0 == current)
        .map_or("", |choice| choice.2);
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(4.))
                .children(choices.iter().map(|&(value, label, _)| {
                    chip(format!("{prefix}-{value}"), label.into(), value == current).on_click(
                        cx.listener(move |this, _, _, cx| {
                            set(this, value);
                            cx.notify();
                        }),
                    )
                })),
        )
        .when(!detail.is_empty(), |d| {
            d.child(note(detail, theme().text_muted))
        })
}

impl Editor {
    fn watch_fields(&self, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(field(
                "Watch source",
                chips(
                    "scheduled-editor-source",
                    &SOURCES,
                    &self.source,
                    |this, value| this.source = value.into(),
                    cx,
                ),
            ))
            .child(field(
                "Action",
                chips(
                    "scheduled-editor-action",
                    &ACTIONS,
                    &self.watch_action,
                    |this, value| this.watch_action = value.into(),
                    cx,
                ),
            ))
            .child(field(
                "Source identity (optional)",
                boxed(
                    "scheduled-editor-source-id",
                    &self.source_id,
                    34.,
                    false,
                    cx,
                ),
            ))
            .child(field(
                "Event types",
                boxed("scheduled-editor-events", &self.events, 34., true, cx),
            ))
            .child(field(
                "Literal filter (optional)",
                boxed("scheduled-editor-literal", &self.literal, 34., false, cx),
            ))
            .when(self.source == "managed_run", |d| {
                d.child(field(
                    "Quiet interval (ms)",
                    boxed("scheduled-editor-quiet", &self.quiet, 34., false, cx),
                ))
            })
            .when(self.watch_action == "steer", |d| {
                d.child(field(
                    "Target lane ID",
                    boxed(
                        "scheduled-editor-target-lane",
                        &self.target_lane,
                        34.,
                        false,
                        cx,
                    ),
                ))
            })
            .child(columns([
                field(
                    "Minimum interval (ms)",
                    boxed(
                        "scheduled-editor-min-interval",
                        &self.min_interval,
                        34.,
                        false,
                        cx,
                    ),
                ),
                field(
                    "Batch window (ms)",
                    boxed(
                        "scheduled-editor-batch-window",
                        &self.batch_window,
                        34.,
                        false,
                        cx,
                    ),
                ),
                field(
                    "Fires per tick",
                    boxed(
                        "scheduled-editor-max-fires",
                        &self.max_fires,
                        34.,
                        false,
                        cx,
                    ),
                ),
            ]))
    }

    fn cron_fields(&mut self, cx: &mut Context<Self>) -> Div {
        let expr = self.cron.read(cx).text.clone();
        if self.hint.0 != expr || self.hint.1.is_empty() {
            let (hint, valid) = cron_hint(&expr);
            self.hint = (expr, hint, valid);
        }
        let color = if self.hint.2 {
            theme().text_muted
        } else {
            theme().danger
        };
        div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(field(
                "Cron expression",
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(boxed(
                        "scheduled-editor-cron-expr",
                        &self.cron,
                        34.,
                        true,
                        cx,
                    ))
                    .child(note(self.hint.1.clone(), color)),
            ))
            .child(columns([
                field(
                    "After downtime",
                    chips(
                        "scheduled-editor-catch-up",
                        &CATCH_UP,
                        &self.catch_up,
                        |this, value| this.catch_up = value.into(),
                        cx,
                    ),
                ),
                field(
                    "Repo concurrency",
                    boxed(
                        "scheduled-editor-concurrency",
                        &self.concurrency,
                        34.,
                        false,
                        cx,
                    ),
                ),
            ]))
    }
}

impl Render for Editor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let editing = self.id.is_some();
        let title = if editing {
            "Edit automation"
        } else {
            "New automation"
        };
        let submit = match (self.saving, editing) {
            (true, true) => "Saving…",
            (true, false) => "Creating…",
            (false, true) => "Save",
            (false, false) => "Create",
        };
        let has_precheck = !self.precheck.read(cx).text.trim().is_empty();
        let repos = self.repos.clone();
        let current_repo = self.repo.clone();
        let cron = (self.trigger == "cron").then(|| self.cron_fields(cx));
        let watch = (self.trigger == "watch").then(|| self.watch_fields(cx));
        div()
            .id("scheduled-editor-scrim")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(24.))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(theme().text)
                    .opacity(0.35),
            )
            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx)))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    this.cancel(cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .id("scheduled-editor")
                    .debug_selector(|| "scheduled-editor".into())
                    .w(px(560.))
                    .max_w_full()
                    .max_h(gpui::relative(0.88))
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(crate::theme::popover_background())
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .px(px(18.))
                            .pt(px(15.))
                            .pb(px(13.))
                            .border_b_1()
                            .border_color(theme().border)
                            .text_size(px(13.5))
                            .child(title)
                            .child(
                                div()
                                    .id("scheduled-editor-close")
                                    .debug_selector(|| "scheduled-editor-close".into())
                                    .size(px(28.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(8.))
                                    .cursor_pointer()
                                    .hover(|d| d.bg(theme().hover))
                                    .child(crate::icon::stroke(
                                        "M18 6 6 18M6 6l12 12",
                                        theme().text_muted,
                                        13.,
                                        1.9,
                                    ))
                                    .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                            ),
                    )
                    .child(
                        div()
                            .id("scheduled-editor-body")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .px(px(18.))
                            .pt(px(16.))
                            .pb(px(18.))
                            .child(field(
                                "Name",
                                boxed("scheduled-editor-name", &self.name, 34., false, cx),
                            ))
                            .child(field(
                                "Prompt",
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(boxed(
                                        "scheduled-editor-prompt",
                                        &self.prompt,
                                        88.,
                                        false,
                                        cx,
                                    ))
                                    .child(note(
                                        "For a scheduled read-only Symon check-in, have the automation finish by running o8 broadcast automation-say \"<concise summary>\". Quiet hours, subscriptions, deduplication, and the hourly budget still apply.",
                                        theme().text_muted,
                                    )),
                            ))
                            .child(columns([
                                field(
                                    "Runtime",
                                    chips(
                                        "scheduled-editor-runtime",
                                        &RUNTIMES,
                                        &self.runtime,
                                        |this, value| this.runtime = value.into(),
                                        cx,
                                    ),
                                ),
                                field(
                                    "Branch",
                                    boxed("scheduled-editor-branch", &self.branch, 34., false, cx),
                                ),
                            ]))
                            .child(field(
                                "Repo",
                                div().flex().flex_wrap().gap(px(4.)).children(
                                    repos.iter().enumerate().map(|(index, (repo, _))| {
                                        let path = repo.clone();
                                        chip(
                                            format!("scheduled-editor-repo-{index}"),
                                            repo.rsplit('/')
                                                .find(|p| !p.is_empty())
                                                .unwrap_or(repo)
                                                .to_owned(),
                                            *repo == current_repo,
                                        )
                                        .on_click(cx.listener(
                                            move |this, _, _, cx| {
                                                this.choose_repo(path.clone(), cx);
                                            },
                                        ))
                                    }),
                                ),
                            ))
                            .child(field(
                                "Precheck (optional)",
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(boxed(
                                        "scheduled-editor-precheck",
                                        &self.precheck,
                                        34.,
                                        true,
                                        cx,
                                    ))
                                    .child(note(
                                        "Exit 0 launches the agent. Any other exit skips it. Errors fail closed.",
                                        theme().text_muted,
                                    )),
                            ))
                            .when(has_precheck, |d| {
                                d.child(field(
                                    "Precheck timeout (ms)",
                                    boxed(
                                        "scheduled-editor-precheck-timeout",
                                        &self.precheck_timeout,
                                        34.,
                                        false,
                                        cx,
                                    ),
                                ))
                            })
                            .child(field(
                                "Trigger",
                                chips(
                                    "scheduled-editor",
                                    &TRIGGERS,
                                    &self.trigger,
                                    |this, value| this.trigger = value.into(),
                                    cx,
                                ),
                            ))
                            .children(cron)
                            .children(watch)
                            .when_some(self.error.clone(), |d, error| {
                                d.child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(theme().danger)
                                        .child(error),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .px(px(18.))
                            .pt(px(11.))
                            .pb(px(13.))
                            .border_t_1()
                            .border_color(theme().border)
                            .child(
                                action(
                                    "scheduled-editor-cancel".into(),
                                    "Cancel",
                                    false,
                                    self.saving,
                                )
                                .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                            )
                            .child(
                                action("scheduled-editor-save".into(), submit, false, self.saving)
                                    .text_color(gpui::white())
                                    .bg(theme().accent)
                                    .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                            ),
                    ),
            )
    }
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
