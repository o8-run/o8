// The active conversation owns quick actions; the shell only reaches it from chrome focus.
use super::*;
struct ComposerControls;
register_shell_feature!(ComposerControls);
impl ShellFeature for ComposerControls {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 45,
            dispatch: |s, event, w, cx| {
                let key = &event.keystroke;
                if key.key != "k"
                    || !key.modifiers.shift
                    || !(key.modifiers.platform || key.modifiers.control)
                {
                    return KeyResult::Unhandled;
                }
                let Some(Content::Session(view)) =
                    s.active().and_then(|tab| s.content.get(&s.key(&tab)))
                else {
                    return KeyResult::Unhandled;
                };
                let view = view.clone();
                if view.update(cx, |s, cx| s.quick_action_shortcut(w, cx)) {
                    KeyResult::Handled
                } else {
                    KeyResult::Unhandled
                }
            },
        }]
    }
}
