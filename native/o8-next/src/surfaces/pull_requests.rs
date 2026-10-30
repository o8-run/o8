use super::*;

#[path = "pull_requests/model.rs"]
mod model;
#[path = "pull_requests/client.rs"]
mod requests;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    views: HashMap<String, Entity<View>>,
}
pub(super) type View = model::PullRequests;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::PullRequests)),
    create: |shell, _, workspace, window, cx| {
        if let Some(view) = shell.surfaces.pull_requests.views.get(&workspace) {
            return Some(Content::PullRequests(view.clone()));
        }
        let client = shell.client.in_workspace(&workspace);
        let view = cx.new(|cx| View::new(client, workspace.clone(), window, cx));
        shell
            .surfaces
            .pull_requests
            .views
            .insert(workspace, view.clone());
        Some(Content::PullRequests(view))
    },
    // The rail entry lives with the surface, so removing this registration
    // removes the entry with it.
    nav: |s, position, cx| {
        if position != NavPosition::BeforeWorkspaces {
            return vec![];
        }
        vec![
            super::rail::button(
                "rail-pull-requests",
                super::rail::Icon::PullRequest,
                "PRs",
                s.active() == Some(Tab::PullRequests),
            )
            .on_click(cx.listener(|this, _, window, cx| {
                this.capture(window, cx);
                this.execute(Command::PullRequests, window, cx);
            }))
            .into_any_element(),
        ]
    },
    ..Registration::new("Pull requests", "Open pull requests", |_, _, _, _| {
        Some((Tab::PullRequests, false))
    })
};
/// Opens the Pull requests tab on one pull request: Activity's destination
/// for a pull request row, as classic opens PrPanel.
pub(super) fn open(
    shell: &mut Shell,
    repo: &str,
    number: u64,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    shell.execute(Command::PullRequests, window, cx);
    if let Some(Content::PullRequests(view)) = shell.content.get(&shell.key(&Tab::PullRequests)) {
        view.update(cx, |view, cx| view.open(repo, number, cx));
    }
}
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        !view.read(cx).loading
    }
}

#[cfg(test)]
#[path = "pull_requests/shell_tests.rs"]
mod shell_tests;

#[cfg(test)]
#[path = "pull_requests/registration_tests.rs"]
mod registration_tests;
