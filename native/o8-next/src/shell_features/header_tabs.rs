use super::*;
use crate::composer::{Composer, Submit};
use gpui::{DragMoveEvent, SharedString};
// Header tab sorting and renaming: useHeaderTabDrag's insertion line and the
// pill's inline rename (double-click or right-click) from WorkspaceHeaderStrip.
struct HeaderTabs;
register_shell_feature!(HeaderTabs);
impl ShellFeature for HeaderTabs {
    fn ticks(&self) -> &'static [TickHook] {
        // Creates the strip's scroll handle, which the header only reads.
        &[TickHook {
            order: 70,
            run: |s, _, _, _| {
                s.features.get::<Tabs>();
            },
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 70,
            dispatch: |s, event, window, cx| {
                if event.keystroke.key == "escape"
                    && s.features
                        .read::<Tabs>()
                        .is_some_and(|tabs| tabs.rename.is_some())
                {
                    finish(s, false, window, cx);
                    return KeyResult::Handled;
                }
                KeyResult::Unhandled
            },
        }]
    }
}

/// The desktop rename input's maxLength.
const MAX_LABEL: usize = 80;

struct Rename {
    index: usize,
    field: Entity<Composer>,
    _subscriptions: [gpui::Subscription; 2],
}

#[derive(Default)]
struct Tabs {
    rename: Option<Rename>,
    /// Where a dragged tab would land: before, or after, this tab.
    insertion: Option<(usize, bool)>,
    scroll: super::tab_scroll::Strip,
}

/// The pill strip's scroll position, once the feature state exists.
pub(super) fn scroll(s: &Shell) -> Option<super::tab_scroll::Strip> {
    s.features.read::<Tabs>().map(|tabs| tabs.scroll.clone())
}

/// A dragged tab, drawn as a pill that follows the pointer.
#[derive(Clone)]
pub(super) struct Dragged {
    pub index: usize,
    pub label: SharedString,
    pub glyph: &'static str,
}
impl Render for Dragged {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        pill(self.label.clone(), self.glyph)
    }
}

/// The floating pill a dragged tab, or the rail's Terminal, is drawn as.
pub(super) fn pill(label: SharedString, glyph: &'static str) -> gpui::Div {
    let geometry = crate::theme::GEOMETRY;
    div()
        .h(px(geometry.tab_height))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(geometry.tab_radius))
        .bg(crate::theme::popover_background())
        .border_1()
        .border_color(theme().border)
        .shadow_md()
        .text_size(px(12.))
        .font_weight(gpui::FontWeight::LIGHT)
        .text_color(theme().text)
        .child(crate::icon::stroke(glyph, theme().text, 11., 2.))
        .child(
            div()
                .max_w(px(180.))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(label),
        )
}

/// The name the person gave this tab, if any.
pub(super) fn label(s: &Shell, tab: &Tab) -> Option<String> {
    s.state.tab_labels.get(&s.key(tab)).cloned()
}

/// The open rename field when it belongs to this tab.
pub(super) fn editing(s: &Shell, index: usize) -> Option<Entity<Composer>> {
    s.features
        .read::<Tabs>()
        .and_then(|tabs| tabs.rename.as_ref())
        .filter(|rename| rename.index == index)
        .map(|rename| rename.field.clone())
}

pub(super) fn insertion(s: &Shell) -> Option<(usize, bool)> {
    s.features.read::<Tabs>().and_then(|tabs| tabs.insertion)
}

/// Opens the inline field with the current name selected.
pub(super) fn rename(
    s: &mut Shell,
    index: usize,
    current: String,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    finish(s, true, window, cx);
    let field = cx.new(|cx| {
        let mut field = Composer::new(cx);
        field.inline = true;
        field.set_text(&current, cx);
        field.select_all(cx);
        field
    });
    let focus = field.read(cx).focus.clone();
    let submit = cx.subscribe_in(&field, window, |s, _, _: &Submit, window, cx| {
        finish(s, true, window, cx);
    });
    let blur = cx.on_blur(&focus, window, |s, window, cx| finish(s, true, window, cx));
    focus.focus(window);
    s.features.get::<Tabs>().rename = Some(Rename {
        index,
        field,
        _subscriptions: [submit, blur],
    });
    cx.notify();
}

/// Closes the field; Enter and blur keep the name, Escape drops it.
fn finish(s: &mut Shell, save: bool, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(rename) = s.features.get::<Tabs>().rename.take() else {
        return;
    };
    let text: String = rename
        .field
        .read(cx)
        .text
        .trim()
        .chars()
        .take(MAX_LABEL)
        .collect();
    if save
        && !text.is_empty()
        && let Some(tab) = s.current().and_then(|w| w.tabs.get(rename.index)).cloned()
    {
        let key = s.key(&tab);
        s.state.tab_labels.insert(key, text);
        s.persist();
    }
    s.restore_focus(window, cx);
    cx.notify();
}

/// Clears the line once a drag leaves the strip or ends.
pub(super) fn settle(s: &mut Shell, cx: &App) {
    if !cx.has_active_drag() {
        s.features.get::<Tabs>().insertion = None;
    }
}

/// The strip sees each drag move first and clears the line; the tab under
/// the pointer then draws it again on its nearer side.
pub(super) fn leave(s: &mut Shell, cx: &mut Context<Shell>) {
    if s.features.get::<Tabs>().insertion.take().is_some() {
        cx.notify();
    }
}

pub(super) fn hover(
    s: &mut Shell,
    index: usize,
    event: &DragMoveEvent<Dragged>,
    cx: &mut Context<Shell>,
) {
    let position = event.event.position;
    if index == event.drag(cx).index || !event.bounds.contains(&position) {
        return;
    }
    let after = position.x >= event.bounds.center().x;
    s.features.get::<Tabs>().insertion = Some((index, after));
    cx.notify();
}

/// Moves the dropped tab to the line and keeps the same tab active.
pub(super) fn drop(s: &mut Shell, from: usize, window: &mut Window, cx: &mut Context<Shell>) {
    finish(s, true, window, cx);
    let Some((target, after)) = s.features.get::<Tabs>().insertion.take() else {
        return;
    };
    let Some(saved) = s
        .state
        .workspaces
        .get_mut(s.state.selected.as_deref().unwrap_or(""))
    else {
        return;
    };
    if from == target || from >= saved.tabs.len() || target >= saved.tabs.len() {
        return;
    }
    let active = saved.tabs.get(saved.active).cloned();
    let tab = saved.tabs.remove(from);
    let to = if from < target { target - 1 } else { target } + usize::from(after);
    saved.tabs.insert(to.min(saved.tabs.len()), tab);
    if let Some(active) = active {
        saved.active = saved.tabs.iter().position(|t| t == &active).unwrap_or(0);
    }
    s.persist();
    cx.notify();
}
