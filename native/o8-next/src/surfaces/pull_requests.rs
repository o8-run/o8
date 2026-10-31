use super::*;

#[path = "pull_requests/comparison.rs"]
mod comparison;
#[path = "pull_requests/model.rs"]
mod model;
#[path = "pull_requests/client.rs"]
mod requests;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    views: HashMap<String, Entity<View>>,
    contexts: HashMap<String, Entity<View>>,
    comparison: Option<Entity<comparison::Compare>>,
}
pub(super) type View = model::PullRequests;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::PullRequests)),
    panel_view,
    create: |shell, _, workspace, window, cx| {
        if let Some(view) = shell.surfaces.pull_requests.views.get(&workspace) {
            return Some(Content::PullRequests(view.clone()));
        }
        let view = hosted_view(shell, &workspace, window, cx);
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
    claim_link: |shell, url, window, cx| {
        let Some((repo, number)) = github_item(url, "pull") else {
            return false;
        };
        open_pull_request(shell, &repo, number, window, cx);
        true
    },
    ..Registration::new("Pull requests", "Open pull requests", |_, _, _, _| {
        Some((Tab::PullRequests, false))
    })
};
fn panel_view(
    shell: &mut Shell,
    request: &serde_json::Value,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<gpui::AnyView> {
    if request["comparison"] == true {
        let view = if let Some(view) = shell.surfaces.pull_requests.comparison.clone() {
            view.update(cx, |view, cx| view.load(cx));
            view
        } else {
            let client = shell.client.clone();
            let view = cx.new(|cx| comparison::Compare::new(client, cx));
            shell.surfaces.pull_requests.comparison = Some(view.clone());
            view
        };
        return Some(view.into());
    }
    let workspace = shell.state.selected.clone().unwrap_or_default();
    if let (Some(repo), Some(number)) = (request["repo"].as_str(), request["number"].as_u64()) {
        let id = format!("{repo}#{number}");
        if let Some(view) = shell.surfaces.pull_requests.contexts.get(&id) {
            return Some(view.clone().into());
        }
        let client = shell.client.clone();
        let view =
            cx.new(|cx| View::new_context(client, workspace, repo.to_owned(), number, window, cx));
        shell
            .surfaces
            .pull_requests
            .contexts
            .insert(id, view.clone());
        return Some(view.into());
    }
    if let Some(view) = shell.surfaces.pull_requests.views.get(&workspace) {
        view.read(cx).focus.focus(window);
        return Some(view.clone().into());
    }
    let view = hosted_view(shell, &workspace, window, cx);
    view.read(cx).focus.focus(window);
    Some(view.into())
}
/// The workspace's list. A picked pull request opens in the right panel's
/// PR tabs, as classic's PRs list opens RightPrTabs.
fn hosted_view(
    shell: &mut Shell,
    workspace: &str,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Entity<View> {
    let client = shell.client.in_workspace(workspace);
    let view = cx.new(|cx| {
        let mut view = View::new(client, workspace.to_owned(), window, cx);
        view.hosted = true;
        view
    });
    shell.subscriptions.push(cx.subscribe_in(
        &view,
        window,
        |shell, _, event: &model::OpenPr, window, cx| {
            shell.open_pr_in_panel(event.repo.clone(), event.number, window, cx);
        },
    ));
    shell
        .surfaces
        .pull_requests
        .views
        .insert(workspace.to_owned(), view.clone());
    view
}
/// Opens the Pull requests tab on one pull request, as classic Activity
/// opens PrPanel.
fn open_pull_request(
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
