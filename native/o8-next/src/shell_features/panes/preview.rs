// The worker grid's layout preview, as classic's WorkerSplitPreview
// (src/components/desktop/workspace-terminal/WorkerSplitPreview.tsx): 4 or
// 10 simulated workers join one by one beside the live main pane, in the
// automatic grid real workers use. Nothing here is saved, dispatched or
// listed as an agent; ending the preview puts the workspace's own panes back.
use super::*;
use crate::pane_tree::{Leaf, Node, Zone};
use gpui::SharedString;
use std::time::Duration;

/// Classic's simulated workers: name, task, status and latest note.
const WORKERS: [(&str, &str, &str, &str); 10] = [
    (
        "Cosmo",
        "Map the handoff path",
        "Working",
        "Tracing the request and reply.",
    ),
    (
        "Atlas",
        "Verify the message receipt",
        "Review",
        "The reply links to the original request.",
    ),
    (
        "Nova",
        "Check runtime recovery",
        "Working",
        "Checking the latest continuation.",
    ),
    (
        "Rune",
        "Audit the split layout",
        "Needs input",
        "Ready for a layout decision.",
    ),
    (
        "Vale",
        "Inspect the CLI path",
        "Working",
        "Comparing the native entry points.",
    ),
    (
        "Echo",
        "Check agent identity",
        "Working",
        "Mapping names to live sessions.",
    ),
    (
        "Sage",
        "Review plugin contracts",
        "Review",
        "The first executable pilot is scoped.",
    ),
    (
        "Orion",
        "Test approval recovery",
        "Working",
        "Following the operator decision.",
    ),
    (
        "Mira",
        "Measure first use",
        "Idle",
        "Waiting for the next interaction.",
    ),
    (
        "Kite",
        "Verify persisted state",
        "Working",
        "Comparing the reload result.",
    ),
];
/// The pause between two workers joining, as classic's.
const ARRIVAL: Duration = Duration::from_millis(180);
/// Shows the preview's launch button over the panes in a dev window.
const LAUNCH_ENV: &str = "O8_DEV_WORKER_PREVIEW";
/// The narrowest a worker card gets before the grid drops a column.
const CARD_MIN: f32 = 230.;

pub(super) struct Preview {
    /// How many workers this run adds.
    target: usize,
    /// Which of WORKERS show, in arrival order.
    workers: Vec<usize>,
    pub(super) tree: Node,
    pub(super) focused: Option<String>,
    /// A moved divider keeps its geometry: later arrivals and closes split
    /// and merge in place instead of rebuilding the grid.
    pub(super) manual: bool,
    /// The most worker columns the panes' measured width fits.
    columns: usize,
}

fn leaf_id(index: usize) -> String {
    format!("preview-worker-{}", index + 1)
}

impl Preview {
    fn grid(&self) -> Node {
        Node::worker_grid(
            Node::main(),
            self.workers
                .iter()
                .map(|&index| Node::Leaf {
                    id: leaf_id(index),
                    content: Leaf::Worker {
                        agent: WORKERS[index].0.into(),
                    },
                })
                .collect(),
            self.columns,
        )
    }
    /// The panes are `width` wide: the grid keeps its cards at least
    /// CARD_MIN beside the main pane.
    fn fit(&mut self, width: f32) -> bool {
        let room = width - super::MAIN_MIN;
        let columns = ((room / CARD_MIN).floor() as usize).clamp(1, 4);
        if columns == self.columns {
            return false;
        }
        self.columns = columns;
        if !self.manual {
            self.tree = self.grid();
        }
        true
    }
    fn arrive(&mut self, index: usize) {
        let id = leaf_id(index);
        let last = self.workers.last().map(|&last| leaf_id(last));
        self.workers.push(index);
        match last.filter(|_| self.manual) {
            Some(last) => {
                let worker = Leaf::Worker {
                    agent: WORKERS[index].0.into(),
                };
                self.tree.split(&last, Zone::Right, id.clone(), worker);
            }
            None => self.tree = self.grid(),
        }
        self.focused = Some(id);
    }
    /// closeSessionLeaf: the grid reflows unless a divider was moved.
    pub(super) fn close(&mut self, leaf: &str) {
        self.workers.retain(|&index| leaf_id(index) != leaf);
        if self.focused.as_deref() == Some(leaf) {
            self.focused = None;
        }
        if self.manual {
            self.tree.close(leaf);
        } else {
            self.tree = self.grid();
        }
    }
}

pub(super) fn start(s: &mut Shell, count: usize, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    state.preview_run += 1;
    let run = state.preview_run;
    state.preview = Some(Preview {
        target: count,
        workers: vec![],
        tree: Node::main(),
        focused: None,
        manual: false,
        columns: 4,
    });
    cx.notify();
    cx.spawn(async move |this, cx| {
        for index in 0..count {
            cx.background_executor().timer(ARRIVAL).await;
            let live = this.update(cx, |s, cx| {
                let state = s.features.get::<State>();
                if state.preview_run != run {
                    return false;
                }
                let Some(preview) = state.preview.as_mut() else {
                    return false;
                };
                preview.arrive(index);
                cx.notify();
                true
            });
            if !matches!(live, Ok(true)) {
                return;
            }
        }
    })
    .detach();
}

pub(super) fn end(s: &mut Shell, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    state.preview_run += 1;
    state.preview = None;
    cx.notify();
}

pub(super) static FOUR: PaletteCommand = PaletteCommand {
    id: "worker-preview-4",
    label: "Preview 4 workers",
    run: |s, window, cx| {
        s.palette = false;
        start(s, 4, cx);
        s.restore_focus(window, cx);
    },
};
pub(super) static TEN: PaletteCommand = PaletteCommand {
    id: "worker-preview-10",
    label: "Preview 10 workers",
    run: |s, window, cx| {
        s.palette = false;
        start(s, 10, cx);
        s.restore_focus(window, cx);
    },
};
pub(super) static END: PaletteCommand = PaletteCommand {
    id: "worker-preview-end",
    label: "End worker preview",
    run: |s, window, cx| {
        s.palette = false;
        end(s, cx);
        s.restore_focus(window, cx);
    },
};
pub(super) fn commands(s: &Shell) -> Vec<Command> {
    let active = s
        .features
        .read::<State>()
        .is_some_and(|state| state.preview.is_some());
    let mut commands = vec![Command::Feature(&FOUR), Command::Feature(&TEN)];
    if active {
        commands.push(Command::Feature(&END));
    }
    commands
}

/// The panes with the preview's bar over them, or with the launch button in
/// a dev window.
pub(super) fn wrap(s: &Shell, panes: AnyElement, cx: &mut Context<Shell>) -> AnyElement {
    let shown = s
        .features
        .read::<State>()
        .and_then(|state| state.preview.as_ref())
        .map(|preview| (preview.workers.len(), preview.target));
    let frame = div()
        .size_full()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .min_h_0();
    match shown {
        Some((shown, target)) => {
            let measured = cx.entity().downgrade();
            let measure = gpui::canvas(
                |_, _, _| (),
                move |bounds, _, _, cx| {
                    let width = f32::from(bounds.size.width);
                    let _ = measured.update(cx, |s, cx| {
                        let state = s.features.get::<State>();
                        if state.preview.as_mut().is_some_and(|p| p.fit(width)) {
                            cx.notify();
                        }
                    });
                },
            )
            .absolute()
            .size_full();
            frame
                .child(bar(shown, target, cx))
                .child(
                    div()
                        .relative()
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .min_h_0()
                        .child(measure)
                        .child(panes),
                )
                .into_any_element()
        }
        None if std::env::var_os(LAUNCH_ENV).is_some() => frame
            .relative()
            .child(panes)
            .child(
                div().absolute().right(px(14.)).bottom(px(14.)).child(
                    button(
                        "worker-preview-launch",
                        "Preview 4 / 10 workers",
                        cx,
                        |s, cx| start(s, 4, cx),
                    )
                    .shadow_md(),
                ),
            )
            .into_any_element(),
        None => panes,
    }
}

fn bar(shown: usize, target: usize, cx: &mut Context<Shell>) -> impl IntoElement {
    div()
        .debug_selector(|| "worker-preview-bar".into())
        .h(px(40.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap(px(6.))
        .px(px(12.))
        .border_b_1()
        .border_color(theme().border)
        .text_size(px(11.5))
        .text_color(theme().text_secondary)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(format!(
                    "Layout preview · {shown} of {target} simulated workers"
                )),
        )
        .child(button("worker-preview-4", "4 workers", cx, |s, cx| {
            start(s, 4, cx)
        }))
        .child(button("worker-preview-10", "10 workers", cx, |s, cx| {
            start(s, 10, cx)
        }))
        .child(button("worker-preview-end", "End preview", cx, |s, cx| {
            end(s, cx)
        }))
}

fn button(
    id: &'static str,
    label: &'static str,
    cx: &mut Context<Shell>,
    run: fn(&mut Shell, &mut Context<Shell>),
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .flex_shrink_0()
        .px(px(9.))
        .py(px(4.))
        .rounded(px(7.))
        .border_1()
        .border_color(theme().border)
        .bg(crate::theme::popover_background())
        .text_size(px(11.5))
        .text_color(theme().text)
        .cursor_pointer()
        .hover(|b| b.bg(theme().hover))
        .child(label)
        .on_click(cx.listener(move |s, _, _, cx| run(s, cx)))
}

/// A simulated worker's pane: classic's MockWorkerPane, a card with its name,
/// model, status and close, its task and latest note, and its steer line.
pub(super) fn card(s: &Shell, id: &str, agent: &str, cx: &mut Context<Shell>) -> AnyElement {
    let (name, task, status, note) = WORKERS
        .iter()
        .copied()
        .find(|worker| worker.0 == agent)
        .unwrap_or((agent, "", "Working", ""));
    let focused = s
        .features
        .read::<State>()
        .and_then(|state| state.preview.as_ref())
        .is_some_and(|preview| preview.focused.as_deref() == Some(id));
    let tone = match status {
        "Needs input" => theme().warning,
        "Review" => theme().accent,
        "Idle" => theme().text_faint,
        _ => theme().success,
    };
    let (focus, close) = (id.to_owned(), id.to_owned());
    div()
        .id(SharedString::from(format!("pane-worker-{id}")))
        .debug_selector({
            let id = id.to_owned();
            move || format!("pane-worker-{id}")
        })
        .size_full()
        .p(px(5.))
        .child(
            div()
                .size_full()
                .flex()
                .flex_col()
                .overflow_hidden()
                .rounded(px(12.))
                .border_1()
                .border_color(if focused {
                    gpui::Rgba {
                        a: 0.75,
                        ..theme().accent
                    }
                } else {
                    theme().border
                })
                .bg(theme().surface)
                .when(focused, |card| card.shadow_md())
                .child(
                    div()
                        .h(px(34.))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .gap(px(7.))
                        .pl(px(11.))
                        .pr(px(6.))
                        .border_b_1()
                        .border_color(theme().border)
                        .text_size(px(12.))
                        .child(
                            div()
                                .size(px(7.))
                                .flex_shrink_0()
                                .rounded_full()
                                .bg(crate::subagents::trace::agent_color(name)),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_shrink()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_color(theme().text)
                                .child(format!("@{name}")),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(11.))
                                .text_color(theme().text_faint)
                                .child("Codex · GPT-6 Sol"),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(5.))
                                .text_size(px(11.))
                                .text_color(theme().text_secondary)
                                .child(div().size(px(5.)).rounded_full().bg(tone))
                                .child(status),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("pane-close-{id}")))
                                .debug_selector({
                                    let id = id.to_owned();
                                    move || format!("pane-close-{id}")
                                })
                                .flex_shrink_0()
                                .size(px(22.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(6.))
                                .cursor_pointer()
                                .text_color(theme().text_muted)
                                .hover(|d| d.bg(theme().hover).text_color(theme().text))
                                .child("×")
                                .on_click(cx.listener(move |s, _, _, cx| {
                                    cx.stop_propagation();
                                    if let Some(preview) =
                                        s.features.get::<State>().preview.as_mut()
                                    {
                                        preview.close(&close);
                                    }
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .overflow_hidden()
                        .px(px(12.))
                        .py(px(10.))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(10.))
                                .text_color(theme().text_faint)
                                .child("SIMULATED TASK"),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(theme().text)
                                .child(task),
                        )
                        .child(
                            div()
                                .mt(px(4.))
                                .px(px(10.))
                                .py(px(6.))
                                .flex()
                                .rounded(px(8.))
                                .bg(theme().hover)
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .text_size(px(12.))
                                        .text_color(theme().text_secondary)
                                        .child(note),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .px(px(12.))
                        .py(px(8.))
                        .border_t_1()
                        .border_color(theme().border)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(11.))
                                .text_color(theme().text_faint)
                                .child(format!("To @{name} · simulated steer")),
                        ),
                ),
        )
        .on_click(cx.listener(move |s, _, _, cx| {
            if let Some(preview) = s.features.get::<State>().preview.as_mut() {
                preview.focused = Some(focus.clone());
            }
            cx.notify();
        }))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::test_support::*;
    use gpui::{Modifiers, MouseButton};

    fn settle(v: &mut VisualTestContext, ms: u64) {
        let until = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < until {
            v.run_until_parked();
            draw(v);
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn workers(s: &Entity<Shell>, v: &VisualTestContext) -> Vec<String> {
        s.read_with(v, |s, _| {
            tree(s)
                .leaves()
                .into_iter()
                .filter(|(_, leaf)| matches!(leaf, Leaf::Worker { .. }))
                .map(|(id, _)| id.to_owned())
                .collect()
        })
    }
    fn preview<T>(s: &Entity<Shell>, v: &VisualTestContext, read: impl Fn(&Preview) -> T) -> T {
        s.read_with(v, |s, _| {
            read(
                s.features
                    .read::<State>()
                    .unwrap()
                    .preview
                    .as_ref()
                    .unwrap(),
            )
        })
    }
    #[track_caller]
    fn click(v: &mut VisualTestContext, id: &str) {
        draw(v);
        let at = v
            .debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
            .unwrap_or_else(|| panic!("missing {id}"))
            .center();
        v.simulate_click(at, Modifiers::default());
        settle(v, 50);
    }

    #[gpui::test]
    fn simulated_workers_fill_the_grid_and_leave_the_saved_panes_alone(cx: &mut TestAppContext) {
        let f = Fixture::start(true);
        let (s, mut v) = open(
            f.client.clone(),
            f.root.join("worker-preview.json"),
            crate::shell_state::State::default(),
            cx,
        );
        ready(&s, &mut v);
        v.simulate_resize(size(px(1800.), px(1000.)));
        settle(&mut v, 100);
        s.update_in(&mut v, |s, _, cx| start(s, 4, cx));
        for _ in 0..4 {
            v.executor().advance_clock(ARRIVAL);
            settle(&mut v, 20);
        }
        assert_eq!(workers(&s, &v).len(), 4, "four join, one by one");
        assert!(v.debug_bounds("worker-preview-bar").is_some());
        assert!(
            v.debug_bounds("pane-main").is_some(),
            "the chat keeps its pane"
        );
        assert_eq!(
            preview(&s, &v, |p| p.focused.clone()),
            Some("preview-worker-4".into()),
            "the newest worker has focus"
        );
        assert!(
            s.read_with(&v, |s, _| s.current().and_then(|w| w.panes.clone()))
                .is_none(),
            "a preview is never saved"
        );

        click(&mut v, "pane-worker-preview-worker-2");
        assert_eq!(
            preview(&s, &v, |p| p.focused.clone()),
            Some("preview-worker-2".into())
        );
        click(&mut v, "pane-close-preview-worker-1");
        assert_eq!(
            workers(&s, &v),
            ["preview-worker-2", "preview-worker-3", "preview-worker-4"],
            "the grid reflows around a close"
        );

        // Dragging the main pane's divider keeps the new width: the grid
        // stops reflowing, so the next close merges in place.
        let divider = v
            .debug_bounds("pane-divider-grid")
            .expect("grid divider")
            .center();
        v.simulate_mouse_down(divider, MouseButton::Left, Modifiers::default());
        let nudge = divider + gpui::point(px(12.), px(0.));
        v.simulate_mouse_move(nudge, Some(MouseButton::Left), Modifiers::default());
        draw(&mut v);
        let to = divider + gpui::point(px(160.), px(0.));
        v.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
        draw(&mut v);
        v.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
        settle(&mut v, 50);
        let ratio = |s: &Entity<Shell>, v: &VisualTestContext| {
            preview(s, v, |p| match &p.tree {
                Node::Split { ratio, .. } => *ratio,
                _ => 0.,
            })
        };
        assert!(preview(&s, &v, |p| p.manual));
        let moved = ratio(&s, &v);
        click(&mut v, "pane-close-preview-worker-3");
        assert_eq!(workers(&s, &v), ["preview-worker-2", "preview-worker-4"]);
        assert_eq!(ratio(&s, &v), moved, "a moved divider stays put");

        click(&mut v, "worker-preview-end");
        assert!(workers(&s, &v).is_empty());
        assert!(v.debug_bounds("worker-preview-bar").is_none());
        assert!(v.debug_bounds("pane-main").is_some());
    }

    #[test]
    fn the_grid_drops_columns_to_keep_cards_readable() {
        let mut preview = Preview {
            target: 10,
            workers: (0..10).collect(),
            tree: Node::main(),
            focused: None,
            manual: false,
            columns: 4,
        };
        let row_lengths = |preview: &Preview| {
            let Node::Split { children, .. } = &preview.tree else {
                panic!("a grid")
            };
            fn rows(node: &Node) -> Vec<usize> {
                match node {
                    Node::Split {
                        vertical: false,
                        children,
                        ..
                    } => [rows(&children[0]), rows(&children[1])].concat(),
                    row => vec![row.leaves().len()],
                }
            }
            rows(&children[1])
        };
        assert!(preview.fit(400. + 3. * 230. + 10.));
        assert_eq!(row_lengths(&preview), [3, 3, 2, 2]);
        assert!(
            !preview.fit(400. + 3. * 230. + 40.),
            "the same fit keeps the tree"
        );
        assert!(preview.fit(400. + 100.));
        assert_eq!(row_lengths(&preview).iter().sum::<usize>(), 10);
        assert!(row_lengths(&preview).iter().all(|&n| n == 1), "one column");
    }
}
