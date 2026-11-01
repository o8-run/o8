//! Local questions join Needs reply; existing approval/maintainer polling is unchanged.
use super::*;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QuestionFeed {
    #[serde(default)]
    questions: Vec<Value>,
    #[serde(default)]
    questions_truncated: bool,
    question_error: Option<String>,
}
impl Card {
    pub(super) fn question(item: &Value) -> Self {
        let mut card = Self::base(item);
        card.source = "bot_question".into();
        card.title = text(item, "title");
        card.detail = text(item, "text");
        card.metadata = text(item, "repoPath");
        card.session = text(item, "sessionKey");
        card
    }
}
impl Inbox {
    pub(super) fn start_question_read(&mut self) -> u64 {
        self.questions_generation += 1;
        self.questions_at = Instant::now();
        self.questions_generation
    }
    pub(super) fn accept_questions(&mut self, feed: QuestionFeed) {
        if let Some(error) = feed.question_error {
            self.errors[3] = Some(error);
            return;
        }
        self.questions = feed.questions;
        self.errors[3] = feed.questions_truncated.then(|| "More questions are waiting. Answer listed questions and refresh, or open their Inbox threads.".into());
    }
    pub(super) fn tick_questions(&mut self, cx: &mut Context<Self>) {
        if self.questions_loading || self.questions_at.elapsed() < Duration::from_secs(10) {
            return;
        }
        self.questions_loading = true;
        let generation = self.start_question_read();
        let revision = self.revision;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let all = self.all;
        let task = cx.background_executor().spawn(async move {
            let mut query = vec![("includeQuestions", "1"), ("questionsOnly", "1")];
            if !all {
                query.push(("questionsRepoPath", workspace.as_str()));
            }
            client.get::<QuestionFeed>("/api/panel/supervisor-inbox", &query)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.questions_loading = false;
                if revision != this.revision || generation != this.questions_generation { return; }
                match result {
                    Ok(feed) => this.accept_questions(feed),
                    Err(error) => this.errors[3] = Some(format!("Questions could not be refreshed. Previous questions are still shown. {error}")),
                }
                this.rebuild(cx);
                cx.notify();
            });
        }).detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::bots::ask_user_tests::Fixture;
    use gpui::TestAppContext;

    #[gpui::test]
    fn ask_user_poll_is_queued_while_the_full_inbox_is_still_loading(cx: &mut TestAppContext) {
        let fixture = Fixture::new();
        fixture.read("/fixture/slow-full");
        let client = fixture.client.clone();
        let (inbox, cx) = cx.add_window_view(|_, cx| Inbox::new(client, String::new(), cx));
        inbox.update(cx, |inbox, cx| {
            inbox.load(cx);
            assert!(inbox.loading, "production full read is pending");
            inbox.questions_at = Instant::now() - Duration::from_secs(11);
            inbox.tick_questions(cx);
            assert!(
                inbox.questions_loading,
                "local questions must not wait for maintainer or approval reads"
            );
        });
        cx.run_until_parked();
        assert!(inbox.read_with(cx, |inbox, _| {
            inbox.cards[0]
                .iter()
                .any(|card| card.id == fixture.data["questionId"].as_str().unwrap())
        }));
        let state = fixture.read("/fixture/state");
        assert!(state["requests"].as_array().unwrap().iter().any(|r| {
            r["path"] == "/api/panel/supervisor-inbox"
                && r["query"]
                    .as_str()
                    .is_some_and(|query| query.contains("questionsOnly=1"))
        }));
    }
}
