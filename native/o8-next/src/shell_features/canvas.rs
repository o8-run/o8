use super::*;
use crate::shell::canvas;
struct Canvas;
register_shell_feature!(Canvas);
impl ShellFeature for Canvas {
    fn commands(&self) -> &'static [PaletteCommands] {
        &[PaletteCommands {
            order: 90,
            collect: |s| {
                if canvas::active(s).is_some() {
                    vec![Command::Feature(&RESET), Command::Feature(&FIT)]
                } else {
                    vec![]
                }
            },
        }]
    }
}
static RESET: PaletteCommand = PaletteCommand {
    id: "canvas-reset-zoom",
    label: "Canvas: Reset zoom",
    run: |s, w, cx| {
        if let Some(view) = canvas::active(s) {
            view.update(cx, |v, cx| v.reset(cx));
        }
        s.palette = false;
        s.restore_focus(w, cx);
        cx.notify();
    },
};
static FIT: PaletteCommand = PaletteCommand {
    id: "canvas-fit-all",
    label: "Canvas: Fit all cards",
    run: |s, w, cx| {
        if let Some(view) = canvas::active(s) {
            view.update(cx, |v, cx| v.fit(cx));
        }
        s.palette = false;
        s.restore_focus(w, cx);
        cx.notify();
    },
};
