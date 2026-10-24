use super::*;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((5, || Command::Terminal)),
    ..Registration::new("", "Open terminal", |s, _, window, cx| {
        s.notice = "This surface is not available in this build. The terminal and packet diff changes must land before the shell can open them.".into();
        s.palette = false;
        s.restore_focus(window, cx);
        cx.notify();
        None
    })
};
