use super::*;
use gpui::AppContext;

impl ActivityPane {
    pub(crate) fn open_commit(&mut self, row: &Row, window: &mut Window, cx: &mut Context<Self>) {
        let repo = self.repos.iter().find(|repo| {
            if self.scope != "*" {
                repo.local_path == self.scope
            } else {
                repo.slug() == row.repo && row.repo.is_some()
                    || row.repo_identity == format!("local:{}", repo.local_path)
            }
        });
        let path = repo
            .map(|r| r.local_path.clone())
            .unwrap_or_else(|| self.workspace.clone());
        let target = crate::diff::Target::Commit {
            path,
            hash: row.id.clone(),
        };
        let client = self.client.clone();
        let view = cx.new(|cx| crate::diff_ui::DiffSurface::new(client, target, window, cx));
        self.commit = Some((format!("{} · {}", row.title, row.id), view));
        self.changed(cx);
    }
}
