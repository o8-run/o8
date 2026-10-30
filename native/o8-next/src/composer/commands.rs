//! Classic composer command metadata and autocomplete; no server-side effects.
use super::*;
#[derive(Clone, Copy)]
pub(crate) struct Command {
    pub command: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub argument: bool,
    pub aliases: &'static [&'static str],
    pub group: &'static str,
}
pub(crate) const COMMANDS: &[Command] = &[
    Command {
        command: "/visualization",
        title: "Visualize",
        description: "Create an interactive chart, diagram, or illustration in this reply.",
        argument: true,
        aliases: &["/visualize"],
        group: "command",
    },
    Command {
        command: "/orchestrate",
        title: "Orchestrate",
        description: "Claude coordinates; Codex codes; Claude verifies.",
        argument: true,
        aliases: &["/fleet"],
        group: "route",
    },
    Command {
        command: "/ask",
        title: "Ask the Brain",
        description: "Query the Brain — directives, decisions, past outcomes.",
        argument: true,
        aliases: &[],
        group: "context",
    },
    Command {
        command: "/compact",
        title: "Compact context",
        description: "Run the compactor now and keep only the live tail verbatim.",
        argument: false,
        aliases: &[],
        group: "thread",
    },
    Command {
        command: "/clear",
        title: "Clear thread",
        description: "Archive the current thread and reset the orchestrator session.",
        argument: false,
        aliases: &[],
        group: "thread",
    },
    Command {
        command: "/focus",
        title: "Focus scope",
        description: "Keep only turns tied to one issue ref or file path.",
        argument: true,
        aliases: &[],
        group: "context",
    },
    Command {
        command: "/status",
        title: "Thread status",
        description: "Show tokens, cost, active dispatches, and recent decisions.",
        argument: false,
        aliases: &[],
        group: "command",
    },
    Command {
        command: "/recall",
        title: "Recall archive",
        description: "Pull relevant archived context back into the next turn.",
        argument: true,
        aliases: &[],
        group: "context",
    },
    Command {
        command: "/handoff",
        title: "Prep handoff",
        description: "Prepare a compacted handoff prelude for a fresh session.",
        argument: false,
        aliases: &[],
        group: "thread",
    },
    Command {
        command: "/rule",
        title: "Add a rule",
        description: "Pin a session rule — inherited by every turn and dispatched agent.",
        argument: true,
        aliases: &[],
        group: "context",
    },
    Command {
        command: "/rules",
        title: "Manage rules",
        description: "Open the rules governing this session.",
        argument: false,
        aliases: &[],
        group: "context",
    },
    Command {
        command: "/prompts",
        title: "Saved prompts",
        description: "Search the prompt library and insert one into this composer.",
        argument: false,
        aliases: &[],
        group: "context",
    },
    Command {
        command: "/chat",
        title: "Chat",
        description: "Open a casual o8 chat tab with tools on this repo.",
        argument: true,
        aliases: &[],
        group: "route",
    },
    Command {
        command: "/codex",
        title: "Codex",
        description: "Open a one-agent Codex tab for this repo.",
        argument: true,
        aliases: &[],
        group: "route",
    },
    Command {
        command: "/gemini",
        title: "Gemini",
        description: "Open a one-agent Gemini tab for this repo.",
        argument: true,
        aliases: &[],
        group: "route",
    },
    Command {
        command: "/opencode",
        title: "OpenCode 2",
        description: "Open a one-agent OpenCode 2 tab for this repo.",
        argument: true,
        aliases: &[],
        group: "route",
    },
];
pub(crate) const QUICK: &[(&str, &str, &str, &str)] = &[
    ("prompts", "Prompts", "Insert a saved prompt", ""),
    (
        "dispatch",
        "Dispatch",
        "Dispatch the next packet",
        "Dispatch the next open packet. Show me the packet plan first, then launch.",
    ),
    (
        "decompose",
        "Decompose",
        "Break a big issue into packets",
        "Decompose the following issue into merge-ready packets, each scoped to a single file or subsystem:\n\n",
    ),
    (
        "fix",
        "Fix",
        "File and dispatch a bug fix",
        "File a bug issue and dispatch a fix packet for the following problem:\n\n",
    ),
    (
        "review",
        "Review",
        "Review the latest open PR",
        "Review the latest open PR against main. Flag rule violations, bugs, or missing tests before approving.",
    ),
    (
        "status",
        "Status",
        "Show me what's running",
        "Give me a snapshot of every active packet, lane, and agent session across the fleet.",
    ),
    ("clear", "Clear", "Start a fresh thread", "/clear"),
];
#[derive(Default)]
pub(crate) struct Slash {
    pub enabled: bool,
    pub window: Option<AnyWindowHandle>,
    pub scheduled: bool,
    pub index: usize,
    pub dismissed: Option<String>,
    pub last: String,
    pub scroll: ScrollHandle,
}
pub(crate) struct Execute(pub String, pub AnyWindowHandle);
impl EventEmitter<Execute> for Composer {}
pub(crate) struct Changed(pub bool);
impl EventEmitter<Changed> for Composer {}
pub(crate) fn recognized(text: &str) -> bool {
    let token = text
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    COMMANDS
        .iter()
        .any(|c| c.command == token || c.aliases.contains(&token.as_str()))
}
impl Composer {
    pub(crate) fn slash_suggestions(&self) -> Vec<Command> {
        if !self.controls.slash.enabled
            || self.controls.slash.dismissed.as_ref() == Some(&self.text)
            || self.composing()
        {
            return vec![];
        }
        let text = self.text.trim_start();
        if !text.starts_with('/') {
            return vec![];
        }
        let token = text.split_whitespace().next().unwrap_or("").to_lowercase();
        COMMANDS
            .iter()
            .filter(|c| {
                c.command.starts_with(&token)
                    || c.aliases.iter().any(|alias| alias.starts_with(&token))
            })
            .copied()
            .collect()
    }
    pub(crate) fn apply_slash(
        &mut self,
        command: Command,
        click: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.text.trim();
        let token = text.split_whitespace().next().unwrap_or("");
        let exact = token == command.command || command.aliases.contains(&token);
        if (click && command.argument)
            || (!click && ((!exact && text == token) || (command.argument && text == token)))
        {
            self.set_text(
                &format!(
                    "{}{}",
                    command.command,
                    if command.argument { " " } else { "" }
                ),
                cx,
            );
        } else {
            let value = if !click && exact {
                text.to_owned()
            } else {
                command.command.to_owned()
            };
            self.controls.slash.dismissed = Some(self.text.clone());
            cx.emit(Execute(value, window.window_handle()));
            cx.notify();
        }
        self.focus.focus(window);
    }
    pub(super) fn slash_key(
        &mut self,
        key: &Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if key.modifiers.control
            || key.modifiers.platform
            || key.modifiers.alt
            || key.modifiers.shift
        {
            return false;
        }
        let commands = self.slash_suggestions();
        if commands.is_empty() {
            return false;
        }
        self.controls.slash.index = self.controls.slash.index.min(commands.len() - 1);
        match key.key.as_str() {
            "up" | "down" => {
                let delta = if key.key == "up" {
                    commands.len() - 1
                } else {
                    1
                };
                self.controls.slash.index = (self.controls.slash.index + delta) % commands.len();
                self.controls
                    .slash
                    .scroll
                    .scroll_to_item(self.controls.slash.index);
                cx.notify();
                cx.emit(Changed(false));
            }
            "escape" => {
                self.controls.slash.dismissed = Some(self.text.clone());
                self.controls.slash.index = 0;
                cx.notify();
                cx.emit(Changed(false));
            }
            "enter" => self.apply_slash(commands[self.controls.slash.index], false, window, cx),
            _ => return false,
        }
        cx.stop_propagation();
        true
    }
}
