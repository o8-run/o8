use super::*;
use crate::{pane_grid::Grid, pane_layout};
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = Grid;
pub(super) const REGISTRATION: Registration = Registration {
    create,
    command: Some((3, || Command::Grid)),
    ..Registration::new("Grid", "Open grid", |_, _, _, _| Some((Tab::Grid, false)))
};
fn create(
    shell: &mut Shell,
    _tab: Tab,
    workspace: String,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<Content> {
    let client = shell.client.in_workspace(&workspace);

    let options = pane_layout::Options {
        size: 4,
        workspace,
        file: shell.file.with_extension("grid.json"),
    };
    if let Err(error) = options.load() {
        shell.notice = error;
        return None;
    }
    let grid = cx.new(|cx| Grid::new(client, options, window, cx));
    grid.update(cx, |g, cx| g.load(cx));
    Some(Content::Grid(grid))
}
impl ShellView for Grid {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.update(cx, |g, cx| g.shell_focus(window, cx));
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        view.update(cx, |g, cx| {
            g.poll(cx);
            if refresh {
                g.load(cx);
            }
        });
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx)
            .panes
            .iter()
            .any(|p| p.transcript.is_some() && !p.painted_rows.borrow().is_empty())
    }
}
