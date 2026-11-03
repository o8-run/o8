//! The `!` line the composer last ran: a strip over the draft with Esc to
//! stop it and Add to chat, which puts the command and its output's tail in
//! the draft. The output itself streams in the workspace's terminal.
use super::*;
use crate::composer::shell::{ShellRun, chat_block, with_block};
use crate::terminal_grid::CommandOutput;
use gpui::AnyElement;

impl Surface {
    pub(super) fn shell_run_strip(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let ShellRun { line, stopped } = self.shell_run.clone()?;
        let add = self.composer_button(
            "composer-shell-add",
            "Add to chat",
            true,
            cx,
            |s, window, cx| {
                if let Some(run) = &s.shell_run {
                    crate::ui::add_shell_output(
                        run.line.clone(),
                        cx.entity().downgrade(),
                        window,
                        cx,
                    );
                }
            },
        );
        let dismiss =
            self.composer_button("composer-shell-dismiss", "Dismiss", true, cx, |s, _, cx| {
                s.shell_run = None;
                cx.notify();
            });
        Some(
            div()
                .debug_selector(|| "composer-shell-run".into())
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(14.))
                .pt(px(6.))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .font_family(theme().font_mono)
                        .text_size(px(11.5))
                        .text_color(theme().text_secondary)
                        .child(crate::text::sanitize(&format!("$ {line}"))),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(if stopped { "Stopped" } else { "Esc stops" }),
                )
                .child(add)
                .child(dismiss)
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
        let Some(run) = self.shell_run.as_mut().filter(|run| !run.stopped) else {
            return false;
        };
        run.stopped = true;
        crate::ui::stop_shell_line(run.line.clone(), window, cx);
        cx.notify();
        true
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
