use super::*;
use crate::composer::mention::groups::{Mentioned, Sent, remember_sent};
use crate::shell::test_support::open;
use crate::shell::test_support::*;

/// The panel's Files view: its root, open file and requested line.
fn files(s: &Entity<Shell>, v: &VisualTestContext) -> (String, Option<String>, Option<usize>) {
    s.read_with(v, |s, cx| {
        let view = s
            .features
            .read::<Panel>()
            .and_then(|panel| panel.files.get(&key(s, Tool::Files)))
            .expect("Files is open")
            .clone();
        let (root, file, line) = view.read(cx).opened();
        (root.to_owned(), file.map(str::to_owned), line)
    })
}

#[gpui::test]
fn sent_worktree_script_and_terminal_pills_jump_on_click(cx: &mut TestAppContext) {
    // The fixture's terminal host lists its own shell, which the pill names.
    let f = Fixture::start_mode(false, "--terminal");
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("mention-jumps.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    let workspace = s.read_with(&v, |s, _| s.state.selected.clone().unwrap());
    let root = std::path::PathBuf::from(crate::shell::session::workspace_path(&workspace));
    std::fs::write(
        root.join("package.json"),
        "{\n  \"name\": \"fixture\",\n  \"scripts\": {\n    \"build\": \"tsc\",\n    \"test\": \"vitest run\"\n  }\n}\n",
    )
    .unwrap();
    let worktree = f.root.join("feature-worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let worktree = worktree.to_string_lossy().into_owned();
    // As a sent message's pills: script, worktree, terminal.
    remember_sent(Sent::object(&Mentioned::Script {
        name: "test".into(),
        command: "vitest run".into(),
    }));
    remember_sent(Sent::object(&Mentioned::Worktree {
        label: "feature".into(),
        path: worktree.clone(),
        branch: Some("feature".into()),
    }));
    remember_sent(Sent::object(&Mentioned::Terminal {
        session: "cortex-next-terminal-fixture".into(),
        lines: vec![],
    }));
    let follow = |s: &Entity<Shell>, v: &mut VisualTestContext, url: &str| {
        s.update_in(v, |s, window, cx| s.open_transcript_link(url, window, cx));
        v.run_until_parked();
        draw(v);
    };

    // A script pill opens package.json at that script's line.
    follow(&s, &mut v, "o8://mention/0");
    let (files_root, file, line) = files(&s, &v);
    assert_eq!(file.as_deref(), Some("package.json"));
    assert_eq!(line, Some(5));
    assert_eq!(files_root, root.to_string_lossy());

    // A worktree pill opens Files for that worktree.
    follow(&s, &mut v, "o8://mention/1");
    assert_eq!(files(&s, &v).0, worktree);

    // A terminal pill shows the panel's Terminal attached to that terminal.
    follow(&s, &mut v, "o8://mention/2");
    let terminal = s.read_with(&v, |s, _| match s.content.get(&key(s, Tool::Terminal)) {
        Some(Content::Terminal(view)) => view.clone(),
        _ => panic!("the panel's Terminal is open"),
    });
    for _ in 0..200 {
        if terminal.read_with(&v, |t, _| {
            t.selected.as_deref() == Some("cortex-next-terminal-fixture") && t.child.is_some()
        }) {
            break;
        }
        s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
        v.run_until_parked();
        draw(&mut v);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(terminal.read_with(&v, |t, _| {
        t.selected.as_deref() == Some("cortex-next-terminal-fixture") && t.child.is_some()
    }));
}
