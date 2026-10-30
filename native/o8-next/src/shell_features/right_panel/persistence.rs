//! Persist only the panel tool identities and migrate the old Inbox tab.
use super::*;

impl Tool {
    fn from_slug(slug: &str) -> Option<Self> {
        std::iter::once(Self::Launcher)
            .chain(Self::GROUPS.iter().flat_map(|(_, tools)| tools.iter().copied()))
            .find(|tool| tool.slug() == slug)
    }
}

pub(super) fn remember(s: &mut Shell) {
    let panel = s.features.get::<Panel>();
    let saved = crate::shell_state::RightPanelState {
        tabs: panel.tabs.iter().map(|tool| tool.slug()).collect(),
        active: panel.current().slug(),
        open: panel.motion.is_open(),
    };
    s.state.right_panel = Some(saved);
    s.persist();
}

pub(super) fn restore(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.features.get::<Panel>().restored {
        return;
    }
    s.features.get::<Panel>().restored = true;
    let Some(saved) = s.state.right_panel.clone() else { return };
    let mut tabs = Vec::new();
    for tool in saved.tabs.iter().filter_map(|slug| Tool::from_slug(slug)) {
        if tool != Tool::Launcher && !tabs.contains(&tool) {
            tabs.push(tool);
        }
    }
    let active = Tool::from_slug(&saved.active);
    let index = tabs.iter().position(|tool| Some(*tool) == active);
    let panel = s.features.get::<Panel>();
    panel.tabs = tabs;
    panel.active = if active == Some(Tool::Launcher) {
        panel.tabs.len()
    } else {
        index.unwrap_or(0)
    };
    let tool = panel.current();
    if saved.open {
        // Create the main surface first so its initial focus cannot steal the
        // restored tool's focus. Only allowlisted tool identities reach show.
        s.ensure(window, cx);
        show(s, tool, window, cx);
    }
}

/// Inbox tabs saved before the panel existed move into the panel.
pub(super) fn move_inbox_tabs(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let active_inbox = s.active() == Some(Tab::Inbox);
    let mut moved = false;
    for saved in s.state.workspaces.values_mut() {
        while let Some(index) = saved.tabs.iter().position(|tab| tab == &Tab::Inbox) {
            saved.tabs.remove(index);
            if index < saved.active {
                saved.active -= 1;
            }
            saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
            moved = true;
        }
    }
    if moved {
        s.content
            .retain(|key, _| key.starts_with("panel|") || !key.ends_with("|Inbox"));
        s.ensure(window, cx);
        if active_inbox {
            show(s, Tool::Inbox, window, cx);
        } else {
            restore(s, window, cx);
            let panel = s.features.get::<Panel>();
            let launcher = panel.current() == Tool::Launcher;
            if !panel.tabs.contains(&Tool::Inbox) {
                panel.tabs.push(Tool::Inbox);
                if launcher {
                    panel.active = panel.tabs.len();
                }
            }
            remember(s);
        }
        cx.notify();
    }
}

