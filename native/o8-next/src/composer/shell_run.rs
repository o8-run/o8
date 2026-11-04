//! The `!` line the composer last ran: a card over the draft with its
//! output as it streams, a clock and its exit, Stop (or Esc), Copy, and Add
//! to chat, which puts the command and its output's tail in the draft. The
//! line runs in the workspace's terminal, which the card reads.
use super::*;
use crate::composer::shell::{CARD_LINES, chat_block, with_block};
use crate::terminal_grid::{CommandOutput, Mark};
use gpui::AnyElement;

/// A prompt chevron and cursor, the terminal mark.
pub(crate) const SHELL_GLYPH: &str = "m5 7 5 5-5 5M12 19h7";

impl Surface {
    fn shell_run_button(
        &mut self,
        id: &str,
        label: &str,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        self.composer_button(id, label, true, cx, move |s, window, cx| {
            s.composer.read(cx).focus.focus(window);
            action(s, window, cx);
        })
        .on_mouse_down(
            gpui::MouseButton::Left,
            cx.listener(|s, _, window, cx| {
                s.composer.read(cx).focus.focus(window);
                window.prevent_default();
                // Override the shared button's own mouse focus listener too.
                cx.stop_propagation();
            }),
        )
    }

    /// The card for the last `!` line, over the composer at the foot of the
    /// transcript. It stays on this client and never reaches the agent.
    pub(super) fn shell_run_card(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let run = self.shell_run.clone()?;
        let state = run.state();
        let status = run.status(std::time::Instant::now());
        let stop = (state == "running").then(|| {
            self.shell_run_button("composer-shell-stop", "Stop", cx, |s, window, cx| {
                s.stop_shell(window, cx);
            })
        });
        let add =
            self.shell_run_button("composer-shell-add", "Add to chat", cx, |s, window, cx| {
                if let Some(run) = &s.shell_run {
                    crate::ui::add_shell_output(
                        run.line.clone(),
                        cx.entity().downgrade(),
                        window,
                        cx,
                    );
                }
            });
        let copy = self.shell_run_button("composer-shell-copy", "Copy", cx, |s, _, cx| {
            if let Some(run) = &s.shell_run {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(run.copy_text()));
            }
        });
        let dismiss = self.shell_run_button("composer-shell-dismiss", "Dismiss", cx, |s, _, cx| {
            s.shell_run = None;
            cx.notify();
        });
        let mono = |text: String, color| {
            div()
                .min_w_0()
                .truncate()
                .font_family(theme().font_mono)
                .text_size(px(11.5))
                .text_color(color)
                .child(crate::text::sanitize(&text))
        };
        let tail = run.output[run.output.len().saturating_sub(CARD_LINES)..].to_vec();
        Some(
            div()
                .debug_selector(|| "composer-shell-run".into())
                .flex()
                .flex_col()
                .gap(px(4.))
                .mb(px(8.))
                .px(px(12.))
                .py(px(8.))
                .border_1()
                .border_color(theme().border)
                .rounded(px(8.))
                .bg(theme().surface_raised)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(crate::icon::stroke(
                            SHELL_GLYPH,
                            theme().text_muted,
                            13.,
                            2.2,
                        ))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(11.5))
                                .text_color(theme().text_secondary)
                                .child("Shell command"),
                        )
                        .child(
                            div()
                                .debug_selector(move || format!("composer-shell-status-{state}"))
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(status),
                        )
                        .children(stop)
                        .child(add)
                        .child(copy)
                        .child(dismiss),
                )
                .child(mono(format!("$ {}", run.line), theme().text_secondary))
                .when(!tail.is_empty(), |card| {
                    card.child(
                        div()
                            .debug_selector(|| "composer-shell-output".into())
                            .flex()
                            .flex_col()
                            .children(tail.into_iter().map(|line| mono(line, theme().text))),
                    )
                })
                .into_any_element(),
        )
    }
    /// Esc on an empty or `!` draft stops the last `!` line once, before it
    /// stops the turn.
    pub(super) fn stop_shell_run(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let input = self.composer.read(cx);
        let draft = input.text.trim();
        if !input.focus.is_focused(window)
            || !(draft.is_empty() || draft.starts_with('!'))
            || !input.mention_suggestions().is_empty()
        {
            return false;
        }
        self.stop_shell(window, cx)
    }
    /// Ctrl-C to the last `!` line, once, while it still runs.
    fn stop_shell(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(run) = self
            .shell_run
            .as_mut()
            .filter(|run| !run.stopped && run.running())
        else {
            return false;
        };
        run.stopped = true;
        crate::ui::stop_shell_line(run.line.clone(), window, cx);
        cx.notify();
        true
    }
    /// Where the terminal stood just before the shell typed the line.
    pub(crate) fn shell_run_began(&mut self, line: &str, mark: Mark, cx: &mut Context<Self>) {
        if let Some(run) = self.shell_run.as_mut().filter(|run| run.line == line) {
            run.before = Some(mark);
            cx.notify();
        }
    }
    /// A read of the terminal for the card; false once there is nothing left
    /// to follow.
    pub(crate) fn shell_run_read(
        &mut self,
        line: &str,
        output: Option<CommandOutput>,
        mark: Option<Mark>,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(run) = self.shell_run.as_mut().filter(|run| run.line == line) else {
            return false;
        };
        run.read(output, mark, std::time::Instant::now());
        // The elapsed clock moves on every read while the line runs.
        cx.notify();
        run.running()
    }
    #[cfg(test)]
    pub(crate) fn shell_run(&self) -> Option<&crate::composer::shell::ShellRun> {
        self.shell_run.as_ref()
    }
    /// The command and its output's tail go above the draft, for the next send.
    pub(crate) fn add_shell_output(
        &mut self,
        line: &str,
        output: Option<CommandOutput>,
        cx: &mut Context<Self>,
    ) {
        let Some(output) = output else {
            self.notice = "That command's output is no longer in the terminal.".into();
            cx.notify();
            return;
        };
        let block = chat_block(line, &output.lines, output.finished);
        let draft = with_block(&self.composer.read(cx).text, &block);
        self.composer.update(cx, |i, cx| i.set_text(&draft, cx));
        self.shell_run = None;
        cx.notify();
    }
}
