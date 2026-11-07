use super::*;
use serde_json::json;

fn agent(id: &str, title: &str, group: Group, started: f64) -> Agent {
    Agent {
        shared: false,
        native: false,
        cleanup: None,
        prompt: None,
        run: String::new(),
        id: id.into(),
        title: title.into(),
        runtime: "claude".into(),
        model: None,
        effort: None,
        parent: None,
        session: Some(format!("llm-chat:thoughts-{id}")),
        group,
        status: match group {
            Group::Working => "Working",
            Group::Attention => "Needs review",
            Group::Done => "Done",
        }
        .into(),
        progress: Some(format!("Started\nEditing {id}.rs\n")),
        result: None,
        started: Some(started),
        finished: None,
        facts: Default::default(),
    }
}

#[test]
fn agent_mentions_match_running_first_newest_first_and_cap() {
    let mut agents = vec![
        agent("done", "Fix done", Group::Done, 9.),
        agent("old", "Fix old", Group::Working, 1.),
        agent("new", "Fix new", Group::Working, 5.),
        agent("review", "Fix review", Group::Attention, 7.),
        agent("other", "Unrelated", Group::Working, 8.),
    ];
    let labels = |found: Vec<Mentioned>| -> Vec<String> {
        found.iter().map(|m| m.label().to_owned()).collect()
    };
    assert_eq!(
        labels(agent_matches(&agents, "fIX")),
        ["Fix new", "Fix old", "Fix review", "Fix done"]
    );
    assert_eq!(
        agent_matches(&agents, "new")[0],
        Mentioned::Agent {
            id: "new".into(),
            label: "Fix new".into(),
            status: "Working".into(),
            activity: "Editing new.rs".into(),
            session: Some("thoughts-new".into()),
        }
    );
    agents.extend((0..8).map(|n| agent(&format!("x{n}"), "Fix more", Group::Done, 0.)));
    assert_eq!(agent_matches(&agents, "fix").len(), 6);
}

#[test]
fn worktree_mentions_list_the_projects_worktrees_without_agent_scratch() {
    let snapshot = json!({"worktrees": [
        {"absolutePath": "/r/main", "branch": "main", "isCurrent": true},
        {"absolutePath": "/r/.claude/worktrees/agent-1", "branch": "agent-1"},
        {"absolutePath": "/r/feature", "branch": "align-spacing"},
        {"absolutePath": "/r/detached"},
    ]});
    let all = worktree_matches(&snapshot, "");
    assert_eq!(
        all.iter().map(Mentioned::label).collect::<Vec<_>>(),
        ["main", "align-spacing", "detached"]
    );
    assert_eq!(
        worktree_matches(&snapshot, "SPACING"),
        [Mentioned::Worktree {
            label: "align-spacing".into(),
            path: "/r/feature".into(),
            branch: Some("align-spacing".into()),
        }]
    );
    // A path matches too.
    assert_eq!(worktree_matches(&snapshot, "/r/feat").len(), 1);
    assert!(worktree_matches(&json!({}), "").is_empty());
}

#[test]
fn script_and_terminal_mentions_match_names() {
    let file = json!({"content": r#"{"scripts":{"build":"tsc -b","dev":"node dev.mjs","test:unit":"vitest"}}"#});
    assert_eq!(
        script_matches(&file, "TEST"),
        [Mentioned::Script {
            name: "test:unit".into(),
            command: "vitest".into(),
        }]
    );
    assert_eq!(script_matches(&file, "").len(), 3);
    assert!(script_matches(&json!({"content": "not json"}), "").is_empty());
    assert!(script_matches(&json!({"error": "File not found"}), "").is_empty());
    let sessions = vec!["o8-shell-1".to_owned(), "dev-server".to_owned()];
    assert_eq!(
        terminal_matches(&sessions, "dev"),
        [Mentioned::Terminal {
            session: "dev-server".into(),
            lines: vec![],
        }]
    );
}

#[test]
fn object_blocks_carry_each_kinds_context() {
    let agent = Mentioned::Agent {
        id: "a".into(),
        label: "Fix <login>".into(),
        status: "Working".into(),
        activity: "Editing a.rs".into(),
        session: None,
    };
    assert_eq!(
        object_block(&agent, None),
        "<mentioned-agent label=\"Fix &lt;login&gt;\" status=\"Working\">\nEditing a.rs\n</mentioned-agent>"
    );
    let tree = Mentioned::Worktree {
        label: "topic".into(),
        path: "/r/topic".into(),
        branch: Some("topic".into()),
    };
    let dirty = json!({"dirty": true, "changedFiles": [{"path": "a"}, {"path": "b"}]});
    assert_eq!(
        object_block(&tree, Some(Ok(dirty))),
        "<mentioned-worktree path=\"/r/topic\" branch=\"topic\" state=\"dirty\">\n2 changed files.\n</mentioned-worktree>"
    );
    let clean = json!({"dirty": false, "changedFiles": []});
    assert!(
        object_block(&tree, Some(Ok(clean))).contains("state=\"clean\">\nNo uncommitted changes.")
    );
    assert!(
        object_block(&tree, Some(Err("offline".into())))
            .contains("state=\"unknown\">\nIts changes could not be read.")
    );
    let script = Mentioned::Script {
        name: "test".into(),
        command: "vitest run && echo </mentioned-script>".into(),
    };
    assert_eq!(
        object_block(&script, None),
        "<mentioned-script name=\"test\">\nvitest run &amp;&amp; echo &lt;/mentioned-script&gt;\n</mentioned-script>"
    );
    let terminal = Mentioned::Terminal {
        session: "dev".into(),
        lines: vec!["$ npm test".into(), "ok".into()],
    };
    assert_eq!(
        object_block(&terminal, None),
        "<mentioned-terminal name=\"dev\">\n$ npm test\nok\n</mentioned-terminal>"
    );
}

#[test]
fn object_blocks_stay_inside_the_budget() {
    // A terminal drops its oldest lines whole and keeps the newest.
    let lines: Vec<String> = (1..=TERMINAL_LINES)
        .map(|n| format!("{n:03} {}", "x".repeat(96)))
        .collect();
    let block = object_block(
        &Mentioned::Terminal {
            session: "dev".into(),
            lines,
        },
        None,
    );
    assert!(block.chars().count() <= BLOCK_BUDGET, "{}", block.len());
    assert!(block.contains(&format!("{TERMINAL_LINES:03} ")));
    assert!(!block.contains("\n001 "));
    let body = block.lines().nth(1).unwrap();
    assert!(body.ends_with('x'), "the oldest kept line is whole: {body}");
    // Other blocks end in an ellipsis.
    let agent = Mentioned::Agent {
        id: "a".into(),
        label: "a".repeat(400),
        status: "Working".into(),
        activity: "y".repeat(5_000),
        session: None,
    };
    let block = object_block(&agent, None);
    assert_eq!(block.chars().count(), BLOCK_BUDGET);
    assert!(block.contains("…\n</mentioned-agent>"));
    assert!(block.contains(&format!("label=\"{}…\"", "a".repeat(127))));
}

#[test]
fn a_sent_mention_reads_as_a_pill_with_its_preview_and_open_link() {
    remember_sent(Sent::thread(
        "Earlier work",
        "thoughts-1",
        "idle",
        Some("topic"),
    ));
    remember_sent(Sent::object(&Mentioned::Script {
        name: "test".into(),
        command: "vitest".into(),
    }));
    let mut nodes = crate::text::markdown("Read @Earlier work, then @test and me@test `@test`");
    pill_nodes(&mut nodes);
    let runs: Vec<_> = nodes[0]
        .runs
        .iter()
        .map(|run| (run.style.as_str(), run.text.as_str()))
        .collect();
    assert_eq!(
        runs,
        [
            ("text", "Read "),
            ("link:o8://mention/0", "@Earlier work"),
            ("text", ", then "),
            ("link:o8://mention/1", "@test"),
            ("text", " and me@test "),
            ("code", "@test"),
        ]
    );
    assert_eq!(
        sent_preview("o8://mention/0"),
        Some((
            "Earlier work".into(),
            vec!["Thread · idle".into(), "Branch topic".into()]
        ))
    );
    assert_eq!(
        sent_link("o8://mention/0").as_deref(),
        Some("o8://thread/thoughts-1")
    );
    // A script has nothing to open; an unknown pill is no mention.
    assert_eq!(sent_link("o8://mention/1"), None);
    assert_eq!(sent_preview("o8://mention/9"), None);
    // The newest pick of a label replaces the earlier one in place.
    remember_sent(Sent::thread("Earlier work", "thoughts-2", "done", None));
    assert_eq!(
        sent_link("o8://mention/0").as_deref(),
        Some("o8://thread/thoughts-2")
    );
}

#[test]
fn an_agent_pill_opens_its_thread_and_a_terminal_previews_its_newest_lines() {
    let sent = Sent::object(&Mentioned::Agent {
        id: "a".into(),
        label: "Fix login".into(),
        status: "Working".into(),
        activity: "Editing a.rs".into(),
        session: Some("thoughts-a".into()),
    });
    assert_eq!(sent.open.as_deref(), Some("thoughts-a"));
    assert_eq!(sent.lines, ["Agent · Working", "Editing a.rs"]);
    let lines: Vec<String> = (1..=10).map(|n| format!("line {n}")).collect();
    let sent = Sent::object(&Mentioned::Terminal {
        session: "dev".into(),
        lines,
    });
    assert_eq!(sent.lines.first().map(String::as_str), Some("line 5"));
    assert_eq!(sent.lines.len(), 6);
    assert_eq!(sent.open, None);
}

#[test]
fn a_terminal_tail_is_its_newest_lines() {
    let grid = std::sync::Arc::new(std::sync::Mutex::new(crate::terminal_grid::Grid::new(
        crate::terminal_grid::Size(80, 24),
    )));
    let output: String = (1..=60).map(|n| format!("line {n}\r\n")).collect();
    grid.lock().unwrap().feed(output.as_bytes(), false);
    crate::terminal::register("o8-shell-tail", &grid);
    assert!(crate::terminal::open_sessions().contains(&"o8-shell-tail".to_owned()));
    let tail = crate::terminal::tail("o8-shell-tail", TERMINAL_LINES).unwrap();
    assert_eq!(tail.len(), TERMINAL_LINES);
    assert_eq!(tail.first().map(String::as_str), Some("line 21"));
    assert_eq!(tail.last().map(String::as_str), Some("line 60"));
    drop(grid);
    assert!(!crate::terminal::open_sessions().contains(&"o8-shell-tail".to_owned()));
    assert_eq!(crate::terminal::tail("o8-shell-tail", 40), None);
}

#[test]
fn worktree_script_and_terminal_pills_jump_and_threads_open() {
    use super::{Jump, script_line};
    let worktree = Sent::object(&Mentioned::Worktree {
        label: "feature".into(),
        path: "/repo/.worktrees/feature".into(),
        branch: None,
    });
    assert_eq!(
        worktree.jump,
        Some(Jump::Worktree("/repo/.worktrees/feature".into()))
    );
    let script = Sent::object(&Mentioned::Script {
        name: "test:unit".into(),
        command: "vitest".into(),
    });
    assert_eq!(script.jump, Some(Jump::Script("test:unit".into())));
    let agent = Sent::object(&Mentioned::Agent {
        id: "a".into(),
        label: "Fix".into(),
        status: "Working".into(),
        activity: String::new(),
        session: Some("thoughts-a".into()),
    });
    assert_eq!(agent.jump, None);
    assert_eq!(Sent::thread("T", "thoughts-t", "idle", None).jump, None);
    let package = "{\n  \"test\": \"top-level\",\n  \"scripts\": {\n    \"build\": \"tsc\",\n    \"test:unit\" : \"vitest\"\n  },\n  \"other\": {\"lint\": 1}\n}\n";
    assert_eq!(script_line(package, "test:unit"), Some(5));
    assert_eq!(script_line(package, "build"), Some(4));
    // Keys outside `scripts` are not scripts.
    assert_eq!(script_line(package, "test"), None);
    assert_eq!(script_line(package, "lint"), None);
}

#[test]
fn saved_pills_read_as_sent_after_a_restart() {
    // The saved shape, as the queue echoes it and history returns it.
    let saved: Vec<Sent> = [
        Sent::object(&Mentioned::Script {
            name: "test".into(),
            command: "vitest run".into(),
        }),
        Sent::object(&Mentioned::Terminal {
            session: "shell-1".into(),
            lines: vec!["token=abc".into()],
        }),
        Sent::thread("Fix the build", "thoughts-9", "ready", None),
    ]
    .iter()
    .filter_map(Sent::saved)
    .collect();
    assert_eq!(
        serde_json::to_value(&saved).unwrap(),
        json!([
            {"label": "test", "title": "test", "lines": ["Script · vitest run"],
             "jump": {"kind": "script", "target": "test"}},
            {"label": "shell-1", "title": "shell-1", "lines": [],
             "jump": {"kind": "terminal", "target": "shell-1"}},
            {"label": "Fix the build", "title": "Fix the build", "lines": ["Thread · ready"],
             "open": "thoughts-9"},
        ])
    );
    // A fresh window has no pills in memory; the history entry brings them back.
    SENT.with(|all| all.borrow_mut().clear());
    let entry: crate::model::Entry = serde_json::from_value(json!({
        "id": "composer-steer-1", "role": "user",
        "text": "Run @test, see @shell-1 and @Fix the build",
        "mentions": saved,
    }))
    .unwrap();
    let rows = crate::model::render_tree(&[entry]);
    let crate::model::Row::Message { nodes, .. } = &rows[0] else {
        panic!("a message row");
    };
    let links: Vec<_> = nodes[0]
        .runs
        .iter()
        .filter(|run| run.style.starts_with("link:"))
        .map(|run| (run.style.as_str(), run.text.as_str()))
        .collect();
    assert_eq!(
        links,
        [
            ("link:o8://mention/0", "@test"),
            ("link:o8://mention/1", "@shell-1"),
            ("link:o8://mention/2", "@Fix the build"),
        ]
    );
    assert_eq!(
        sent_jump("o8://mention/0"),
        Some(Jump::Script("test".into()))
    );
    assert_eq!(
        sent_jump("o8://mention/1"),
        Some(Jump::Terminal("shell-1".into()))
    );
    assert_eq!(
        sent_link("o8://mention/2").as_deref(),
        Some("o8://thread/thoughts-9")
    );
    // Malformed saved pills are ignored, never a crash.
    remember_saved("composer-steer-bad", Some(&json!([{"label": 3}])));
}

#[test]
fn saved_pills_fit_the_queue_limits() {
    // 150 one-unit characters and 75 two-unit emoji, measured as the queue
    // measures, in UTF-16 units.
    let long = format!("{}{}", "界".repeat(150), "😀".repeat(75));
    assert_eq!(long.encode_utf16().count(), 300);
    let mut pills: Vec<Sent> = std::iter::once(long.clone())
        .chain((0..21).map(|n| format!("tree-{n}")))
        .map(|label| {
            Sent::object(&Mentioned::Worktree {
                label,
                path: "/work/tree".into(),
                branch: None,
            })
        })
        .collect();
    pills[1].open = Some(" ".into());
    pills[2].label = "  ".into();
    let saved = saved_all(&pills);
    assert_eq!(saved.len(), 20, "at most 20 pills");
    // Cut to 200 units on a character boundary: 150 + 25 emoji (50 units).
    assert_eq!(
        saved[0].label,
        format!("{}{}", "界".repeat(150), "😀".repeat(25))
    );
    assert!(saved[0].title.encode_utf16().count() <= 4096);
    assert_eq!(saved[1].open, None, "an empty thread id is never sent");
    assert!(
        saved.iter().all(|pill| pill.label != "  "),
        "an empty label is dropped"
    );
}
