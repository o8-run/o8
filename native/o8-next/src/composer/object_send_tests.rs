use super::*;
use crate::composer::mention::{MentionResult, groups::Mentioned};

fn roster_agent(progress: &str) -> crate::subagents::model::Agent {
    crate::subagents::model::Agent {
        shared: false,
        native: false,
        cleanup: None,
        prompt: None,
        run: String::new(),
        id: "agent-fix-login".into(),
        title: "Fix login".into(),
        runtime: "claude".into(),
        model: None,
        effort: None,
        parent: Some("thoughts-composer-first".into()),
        session: Some("thoughts-composer-second".into()),
        group: crate::subagents::model::Group::Working,
        status: "Working".into(),
        progress: Some(progress.into()),
        result: None,
        started: Some(1.),
        finished: None,
        facts: Default::default(),
    }
}

fn groups(s: &Surface, cx: &App) -> Vec<&'static str> {
    let mut groups: Vec<&'static str> = s
        .composer
        .read(cx)
        .mention_suggestions()
        .iter()
        .map(MentionResult::group)
        .collect();
    groups.dedup();
    groups
}

/// The project's listings as the review and files routes return them. The
/// composer fixture serves neither route, and the menu reads them afresh
/// each time it opens, so each opening starts from these.
fn seed_listings(surface: &gpui::Entity<Surface>, cx: &mut VisualTestContext) {
    surface.update(cx, |s, cx| {
        let repo = s
            .sessions
            .iter()
            .find(|t| Some(&t.id) == s.selected.as_ref())
            .and_then(|t| t.repo_path.clone())
            .unwrap();
        let trees = json!({"worktrees": [
            {"absolutePath": repo, "branch": "main", "isCurrent": true},
            {"absolutePath": "/missing/feature", "branch": "align-spacing"},
        ]});
        let package = json!({"content": r#"{"scripts":{"test:unit":"vitest run"}}"#});
        s.composer.update(cx, |i, _| {
            i.controls.mention.sources = Some((repo, trees, package));
        });
    });
}

/// Type `@word` and take the first result with Enter, as a person would.
fn pick(surface: &gpui::Entity<Surface>, cx: &mut VisualTestContext, word: &str, label: &str) {
    seed_listings(surface, cx);
    cx.simulate_input(&format!("@{word}"));
    wait(surface, cx, |s, cx| {
        s.composer
            .read(cx)
            .mention_suggestions()
            .first()
            .is_some_and(|first| first.label() == label)
    });
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
}

#[gpui::test]
fn workspace_mentions_group_the_menu_and_send_a_context_block_per_pick(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let grid = std::sync::Arc::new(std::sync::Mutex::new(crate::terminal_grid::Grid::new(
        crate::terminal_grid::Size(80, 24),
    )));
    let output: String = (1..=50).map(|n| format!("build step {n}\r\n")).collect();
    grid.lock().unwrap().feed(output.as_bytes(), false);
    crate::terminal::register("o8-shell-dev", &grid);
    surface.update(cx, |s, cx| {
        let roster = s.subagents.clone().expect("the selected thread's roster");
        roster.update(cx, |v, cx| {
            v.agents.push(roster_agent("Editing auth.rs"));
            cx.notify();
        });
    });
    seed_listings(&surface, cx);
    focus(&surface, cx);
    cx.simulate_input("Check @");
    wait(&surface, cx, |s, cx| {
        groups(s, cx).starts_with(&["Threads", "Agents", "Worktrees", "Scripts & terminals"])
    });
    for group in [
        "mention-group-agents",
        "mention-group-worktrees",
        "mention-group-scripts",
    ] {
        wait_selector(cx, group);
    }
    cx.simulate_keystrokes("backspace");
    pick(&surface, cx, "fix", "Fix login");
    cx.simulate_input("and ");
    pick(&surface, cx, "unit", "test:unit");
    cx.simulate_input("on ");
    pick(&surface, cx, "spacing", "align-spacing");
    cx.simulate_input("after ");
    pick(&surface, cx, "o8-shell-d", "o8-shell-dev");
    let typed = "Check @Fix login and @test:unit on @align-spacing after @o8-shell-dev";
    surface.update(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text.trim_end(), typed);
        let picks = s.composer.update(cx, |i, _| i.object_mentions());
        assert_eq!(picks.len(), 4, "{picks:?}");
        assert!(matches!(&picks[0], Mentioned::Agent { label, .. } if label == "Fix login"));
        // The roster moves on before the send; the block reads it then.
        let roster = s.subagents.clone().unwrap();
        roster.update(cx, |v, cx| {
            v.agents = vec![roster_agent("Running auth tests")];
            cx.notify();
        });
        s.queue_prompt(cx);
    });
    wait(&surface, cx, |s, _| {
        !s.saving
            && s.queue["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
    });
    surface.read_with(cx, |s, _| {
        let payload = &s.queue["items"][0]["payload"];
        assert_eq!(payload["text"], typed, "the sent text stays as typed");
        let wire = payload["wireMessage"].as_str().unwrap();
        assert!(
            wire.contains(
                "<mentioned-agent label=\"Fix login\" status=\"Working\">\nRunning auth tests\n</mentioned-agent>"
            ),
            "wire: {wire}"
        );
        assert!(wire.contains("<mentioned-script name=\"test:unit\">\nvitest run\n</mentioned-script>"));
        assert!(wire.contains(
            "<mentioned-worktree path=\"/missing/feature\" branch=\"align-spacing\" state=\"unknown\">"
        ));
        let terminal = wire
            .split("<mentioned-terminal name=\"o8-shell-dev\">\n")
            .nth(1)
            .and_then(|rest| rest.split("\n</mentioned-terminal>").next())
            .expect("terminal block");
        let lines: Vec<_> = terminal.lines().collect();
        assert_eq!(lines.len(), 40);
        assert_eq!(lines[0], "build step 11");
        assert_eq!(lines[39], "build step 50");
        // The server saved the pills with the message; the terminal's output
        // went to the agent but stays out of the saved pill.
        let mentions = payload["mentions"].as_array().expect("saved pills");
        let kinds: Vec<_> = mentions
            .iter()
            .map(|m| (m["label"].as_str().unwrap(), m["jump"]["kind"].as_str()))
            .collect();
        assert_eq!(kinds.len(), 4, "{mentions:?}");
        let terminal = mentions
            .iter()
            .find(|m| m["jump"]["kind"] == "terminal")
            .expect("terminal pill");
        assert_eq!(terminal["jump"]["target"], "o8-shell-dev");
        assert_eq!(terminal["lines"], json!([]));
        assert!(kinds.contains(&("test:unit", Some("script"))));
    });
    // The sent message's pills preview what was sent and open the agent's thread.
    assert_eq!(
        crate::composer::mention::groups::sent_link("o8://mention/0").as_deref(),
        Some("o8://thread/thoughts-composer-second")
    );
    drop(grid);
}

#[gpui::test]
fn many_pills_and_a_long_label_still_send_with_the_pills_capped(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    // A 300-unit label (150 characters plus 75 emoji) and 20 more pills.
    let long = format!("{}{}", "界".repeat(150), "😀".repeat(75));
    let labels: Vec<String> = std::iter::once(long)
        .chain((0..20).map(|n| format!("tree-{n}")))
        .collect();
    let typed = format!(
        "Look at {}",
        labels
            .iter()
            .map(|label| format!("@{label}"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    cx.simulate_input(&typed);
    surface.update(cx, |s, cx| {
        s.composer.update(cx, |i, _| {
            i.controls.mention.objects = labels
                .iter()
                .map(|label| Mentioned::Worktree {
                    label: label.clone(),
                    path: "/missing/tree".into(),
                    branch: None,
                })
                .collect();
        });
        s.queue_prompt(cx);
    });
    wait(&surface, cx, |s, _| {
        !s.saving
            && s.queue["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
    });
    surface.read_with(cx, |s, _| {
        // The message went through the real queue and its receipt matched.
        let payload = &s.queue["items"][0]["payload"];
        assert_eq!(payload["text"], typed);
        let mentions = payload["mentions"].as_array().expect("saved pills");
        assert_eq!(mentions.len(), 20);
        assert_eq!(
            mentions[0]["label"],
            format!("{}{}", "界".repeat(150), "😀".repeat(25))
        );
    });
}

#[gpui::test]
fn workspace_mentions_stay_out_of_another_machines_thread(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let grid = std::sync::Arc::new(std::sync::Mutex::new(crate::terminal_grid::Grid::new(
        crate::terminal_grid::Size(80, 24),
    )));
    crate::terminal::register("o8-shell-local", &grid);
    surface.update(cx, |s, cx| {
        let roster = s.subagents.clone().expect("the selected thread's roster");
        roster.update(cx, |v, cx| {
            v.agents.push(roster_agent("Editing auth.rs"));
            cx.notify();
        });
        let selected = s.selected.clone();
        s.sessions
            .iter_mut()
            .find(|t| t.id == selected.clone().unwrap())
            .unwrap()
            .machine = Some("far".into());
    });
    seed_listings(&surface, cx);
    focus(&surface, cx);
    cx.simulate_input("Check @");
    wait(&surface, cx, |s, cx| {
        groups(s, cx).first() == Some(&"Threads")
    });
    surface.read_with(cx, |s, cx| {
        assert_eq!(groups(s, cx), ["Threads"], "only threads for a far thread");
    });
    drop(grid);
}
