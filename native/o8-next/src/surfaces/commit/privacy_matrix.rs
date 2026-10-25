//! Synthetic privacy controls through the commit surface and authenticated Git routes.
use super::corrections::{click, git, open_commit, workspace};
use super::*;

fn secret_cases() -> Vec<(&'static str, String)> {
    // Synthetic, deliberately short and punctuated: no provider-pattern heuristic can catch it.
    let value = "owned@!";
    [
        ("shell", "DATABASE_PASSWORD=VALUE"),
        ("shell-export", "export DATABASE_PASSWORD=VALUE"),
        ("dotenv", "DATABASE_PASSWORD = VALUE # fixture"),
        ("js-dot", "process.env.DATABASE_PASSWORD = VALUE;"),
        (
            "js-index-double",
            "process.env[\"DATABASE_PASSWORD\"] = VALUE;",
        ),
        (
            "js-index-single",
            "process.env['DATABASE_PASSWORD'] = VALUE;",
        ),
        (
            "js-index-template",
            "process.env[`DATABASE_PASSWORD`] = VALUE;",
        ),
        (
            "js-index-spaced",
            "process.env [ 'DATABASE_PASSWORD' ] = VALUE;",
        ),
        ("js-object", "const config = {DATABASE_PASSWORD: VALUE};"),
        (
            "js-object-quoted",
            "const config = {'DATABASE_PASSWORD': VALUE};",
        ),
        (
            "js-object-computed",
            "const config = {[\"DATABASE_PASSWORD\"]: VALUE};",
        ),
        (
            "ts-assertion",
            "(process.env[\"DATABASE_PASSWORD\"]) = VALUE;",
        ),
        (
            "ts-non-null",
            "process.env[\"DATABASE_PASSWORD\"]! = VALUE;",
        ),
        ("python-index", "os.environ[\"DATABASE_PASSWORD\"] = VALUE"),
        (
            "python-index-single",
            "os.environ['DATABASE_PASSWORD'] = VALUE",
        ),
        ("yaml", "database_password: VALUE"),
        ("yaml-quoted", "'database-password': VALUE"),
        ("yaml-block", "DATABASE_PASSWORD: |\n  VALUE"),
        ("json", "{\"DATABASE_PASSWORD\": VALUE}"),
        ("toml", "[database]\nDATABASE_PASSWORD = VALUE"),
        ("toml-quoted", "[database]\n'DATABASE_PASSWORD' = VALUE"),
        ("ini", "[database]\nDATABASE_PASSWORD=VALUE"),
        ("ini-colon", "[database]\nDATABASE_PASSWORD: VALUE"),
    ]
    .into_iter()
    .flat_map(|(name, template)| {
        [
            format!("\"{value}\""),
            format!("'{value}'"),
            format!("`{value}`"),
            value.into(),
        ]
        .into_iter()
        .map(move |literal| (name, template.replace("VALUE", &literal)))
    })
    .chain([
        (
            "json-escaped-key",
            r#"{"DATABASE_PASS\u0057ORD": "owned@!"}"#.into(),
        ),
        ("yaml-flow", "{database.password: 'owned@!'}".into()),
        (
            "namespaced-access-key",
            "config['cloud-access-key'] = 'owned@!'".into(),
        ),
        (
            "ts-identifier-unicode-braced",
            r"const \u{50}ASSWORD = 'owned@!';".into(),
        ),
        (
            "ts-index-as",
            "process.env['PASSWORD' as string] = 'owned@!'".into(),
        ),
        (
            "ts-index-satisfies",
            "process.env['PASSWORD' satisfies string] = 'owned@!'".into(),
        ),
        (
            "ts-index-wrapped-as",
            "process.env[(('PASSWORD') as string)] = 'owned@!'".into(),
        ),
        (
            "ts-index-type-assertion",
            "process.env[<string>'PASSWORD'] = 'owned@!'".into(),
        ),
        (
            "ts-object-as",
            "const config = {['PASSWORD' as string]: 'owned@!'};".into(),
        ),
        (
            "ts-object-wrapped-as",
            "const config = {[(('PASSWORD') as string)]: 'owned@!'};".into(),
        ),
        (
            "ts-object-satisfies",
            "const config = {['PASSWORD' satisfies string]: 'owned@!'};".into(),
        ),
        (
            "ts-object-call",
            "configure({['PASSWORD' as string]: 'owned@!'});".into(),
        ),
        (
            "ts-object-return",
            "function config(){return {['PASSWORD' as string]: 'owned@!'};}".into(),
        ),
        (
            "ts-assignment-wrapped",
            "((process.env['PASSWORD' as string])) = 'owned@!';".into(),
        ),
        (
            "ts-assignment-asserted",
            "(process.env['PASSWORD'] as string) = 'owned@!';".into(),
        ),
        (
            "ts-identifier-asserted",
            "(PASSWORD as string) = 'owned@!';".into(),
        ),
        (
            "ts-augmented-wrapped",
            "((process.env['PASSWORD' as string])) += 'owned@!';".into(),
        ),
        (
            "ts-logical-typed",
            "process.env['PASSWORD' as string] ||= 'owned@!';".into(),
        ),
        ("python-unicode-eight", "os.environ[\"\\U00000050ASSWORD\"] = 'owned@!';".into()),
("toml-unicode-eight", "\"\\U00000050ASSWORD\" = 'owned@!' ".into()),
("yaml-unicode-eight", "\"\\U00000050ASSWORD\": 'owned@!' ".into()),
("python-octal", "os.environ[\"\\120\\101\\123\\123\\127\\117\\122\\104\"] = 'owned@!';".into()),
("python-named-unicode", "os.environ[\"\\N{LATIN CAPITAL LETTER P}\\N{LATIN CAPITAL LETTER A}\\N{LATIN CAPITAL LETTER S}\\N{LATIN CAPITAL LETTER S}\\N{LATIN CAPITAL LETTER W}\\N{LATIN CAPITAL LETTER O}\\N{LATIN CAPITAL LETTER R}\\N{LATIN CAPITAL LETTER D}\"] = 'owned@!';".into()),
("numeric-password-key", "PASSWORD1='owned@!'".into()),
("numeric-api-key", "const apiKey2 = 'owned@!';".into()),
("collapsed-key-with-suffix", "DBPASSWORD_HINT='owned@!'".into()),
        ("python-triple-double-key", "os.environ[\"\"\"PASSWORD\"\"\"] = 'owned@!';".into()),
("python-triple-single-key", "os.environ['''PASSWORD'''] = 'owned@!';".into()),
("python-triple-double-config", "config = \"\"\"{\"PASSWORD\":\"owned@!\"}\"\"\"".into()),
("python-triple-single-config", "config = '''{\"PASSWORD\":\"owned@!\"}'''".into()),
        ("camel-api-key", "config.apiKey = 'owned@!'".into()),
        (
            "short-value",
            "process.env['DATABASE_PASSWORD'] = '!'".into(),
        ),
        (
            "parenthesized-value",
            "config.password = ('owned@!');".into(),
        ),
        (
            "comment-separated",
            "process.env['PASSWORD'] /* fixture */ = 'owned@!';".into(),
        ),
        (
            "postfix-literal",
            "const password = 'owned@!' as const;".into(),
        ),
        (
            "hex-escaped-key",
            r"config['PASS\x57ORD'] = 'owned@!'".into(),
        ),
        (
            "unicode-braced-key",
            r"config['PASS\u{57}ORD'] = 'owned@!'".into(),
        ),
        ("compact-key", "apikey = 'owned@!'".into()),
        ("acronym-key", "config.APIKey = 'owned@!'".into()),
        (
            "dotenv-reference-literal",
            "DATABASE_PASSWORD=process.env.DATABASE_PASSWORD".into(),
        ),
        (
            "shell-reference-literal",
            "export DATABASE_PASSWORD=process.env.DATABASE_PASSWORD".into(),
        ),
        (
            "getter-with-literal",
            "const password = getPassword('owned@!');".into(),
        ),
        (
            "logical-assignment",
            "process.env['PASSWORD'] ||= 'owned@!'".into(),
        ),
        (
            "augmented-assignment",
            "config.password += 'owned@!'".into(),
        ),
        (
            "destructuring-literal",
            "const { password = 'owned@!' } = config.credentials;".into(),
        ),
        (
            "nested-assignment",
            "config[(process.env.PASSWORD = 'owned@!')] = process.env.OTHER;".into(),
        ),
        ("acronym-prefix", "AWSAccessKeyId = 'owned@!'".into()),
        ("collapsed-uppercase", "GITHUBTOKEN='owned@!'".into()),
        (
            "serialized-json",
            r#"const config = '{"PASSWORD":"owned@!"}';"#.into(),
        ),
        ("shell-hash-value", "DATABASE_PASSWORD=#owned".into()),
        ("yaml-slash-value", "password: //owned".into()),
        ("ini-comment-shaped-value", "password=/*owned*/".into()),
        (
            "mixed-case-key",
            "process.env['DATABASE_PaSsWoRd'] = 'owned@!'".into(),
        ),
        (
            "mixed-case-key-suffix",
            "config['DATABASE_PaSsWoRd_HINT'] = 'owned@!'".into(),
        ),
        (
            "mixed-camel-key",
            "config.dataBasePassWordValue = 'owned@!'".into(),
        ),
        (
            "typed-literal",
            "const DATABASE_PASSWORD: string = 'owned@!'".into(),
        ),
    ])
    .chain(
        [")", "}", ",", ";", "|", ">", "("]
            .into_iter()
            .map(|value| ("ini-punctuation-only", format!("password={value}"))),
    )
    .collect()
}
fn benign_cases() -> [&'static str; 34] {
    [
        "const token = getToken();\n",
        "const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;\n",
        "const DATABASE_PASSWORD = process.env['DATABASE_PASSWORD'];\n",
        "const config = {password: process.env.DATABASE_PASSWORD};\n",
        "process.env['DATABASE_PASSWORD'];\n",
        "os.environ[\"DATABASE_PASSWORD\"]\n",
        "const name = 'DATABASE_PASSWORD';\n",
        "// DATABASE_PASSWORD is configured outside this source file.\n",
        "# DATABASE_PASSWORD\n",
        "DATABASE_PASSWORD\n",
        "{\"monkey\": \"banana\", \"keyboard\": \"piano\"}\n",
        "const apiKey = process.env.PROVIDER_KEY;\n",
        "const name = 'password reset instructions';\n",
        "const token = getToken(); // Ordinary reference\n",
        "const PASSWORD: string = process.env.PASSWORD;\n",
        "const config = {\n password: process.env.PASSWORD\n};\n",
        "const config = {password: process.env.PASSWORD, timeout: 100};\n",
        "interface Config { password: string; }\n",
        "type Config = {password: string};\n",
        "config.password = process.env.PASSWORD;\n",
        "process.env['PASSWORD'] = other.password;\n",
        "function login(password, username) {}\n",
        "const {password, token} = config;\n",
        "const password = options.password;\n",
        "const token = getToken(config);\n",
        "const tokenizer = 'english';\n",
        "const secretary = 'Alice';\n",
        "const passwordless = true;\n",
        "os.environ[\"\"\"PASSWORD\"\"\"]\n",
        "message = \"\"\"PASSWORD reset instructions\"\"\"\n",
        "import { getToken } from './auth';\n",
        "const tokenizer2 = 'english';\n",
        "const secretary3 = 'Alice';\n",
        "const passwordless4 = true;\n",
    ]
}

#[test]
fn privacy_key_value_syntax_matrix() {
    let failed: Vec<_> = secret_cases()
        .into_iter()
        .enumerate()
        .filter_map(|(index, (name, source))| (!guard::sensitive(&source)).then_some((index, name)))
        .collect();
    assert!(
        failed.is_empty(),
        "unrecognized secret case labels: {failed:?}"
    );
}
#[test]
fn privacy_benign_lookalike_matrix() {
    let failed: Vec<_> = benign_cases()
        .into_iter()
        .enumerate()
        .filter_map(|(index, source)| guard::sensitive(source).then_some(index))
        .collect();
    assert!(failed.is_empty(), "hidden benign case indices: {failed:?}");
}

fn reload(shell: &Entity<Shell>, visual: &mut VisualTestContext, hash: &str) {
    click(visual, "commit-hash");
    visual.simulate_keystrokes("ctrl-a");
    visual.simulate_input(hash);
    visual.simulate_keystrokes("enter");
    wait_commit(shell, visual);
}
fn assert_private(
    shell: &Entity<Shell>,
    visual: &mut VisualTestContext,
    fixture: &Fixture,
    index: usize,
    name: &str,
) {
    visual.write_to_clipboard(gpui::ClipboardItem::new_string("safe clipboard".into()));
    if let Some(editor) = visual.debug_bounds("commit-editor") {
        visual.simulate_click(editor.center(), gpui::Modifiers::default());
        visual.simulate_keystrokes("ctrl-a ctrl-c");
    }
    draw(visual);
    assert!(
        shell.read_with(visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
            Some(Content::Commit(view)) => view.read(cx).test_hidden_source(cx),
            _ => false,
        }),
        "source reached editor/frame in case {index} ({name})"
    );
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("safe clipboard"),
        "clipboard changed in case {index} ({name})"
    );
    assert!(
        !fs::read_to_string(fixture.root.join("fixture.log"))
            .unwrap_or_default()
            .contains("owned@!"),
        "canary in fixture logs in case {index} ({name})"
    );
}

#[gpui::test]
fn privacy_matrix_workspace_never_reaches_editor_clipboard_or_logs(cx: &mut TestAppContext) {
    // The shared disposable host has a fixed two-minute lifetime. Bound each
    // fixture's cases instead of weakening that lifetime under compiler load.
    for (batch, cases) in secret_cases().chunks(16).enumerate() {
        let fixture = Fixture::new();
        let root = workspace(&fixture);
        let hash = git(&root, &["rev-parse", "HEAD"]);
        let (shell, mut visual) = open_commit(&fixture, cx);
        for (offset, (name, source)) in cases.iter().enumerate() {
            let index = batch * 16 + offset;
            fs::write(root.join("changed.ts"), source).unwrap();
            reload(&shell, &mut visual, &hash);
            assert_private(&shell, &mut visual, &fixture, index, name);
            assert_eq!(
                fs::read_to_string(root.join("changed.ts")).unwrap(),
                *source
            );
        }
    }
}

#[gpui::test]
fn privacy_matrix_committed_snapshot_and_patch_stay_private(cx: &mut TestAppContext) {
    for (batch, cases) in secret_cases().chunks(16).enumerate() {
        let fixture = Fixture::new();
        let root = workspace(&fixture);
        let base = git(&root, &["rev-parse", "HEAD"]);
        let (shell, mut visual) = open_commit(&fixture, cx);
        for (offset, (name, source)) in cases.iter().enumerate() {
            let index = batch * 16 + offset;
            // Fresh safe parent: a previous secret's deleted line cannot
            // accidentally satisfy this case's guard.
            git(&root, &["checkout", "-q", "-B", "privacy-matrix", &base]);
            fs::write(root.join("changed.ts"), source).unwrap();
            git(&root, &["add", "changed.ts"]);
            git(&root, &["commit", "-qm", "synthetic matrix"]);
            let hash = git(&root, &["rev-parse", "HEAD"]);
            reload(&shell, &mut visual, &hash);
            assert_private(&shell, &mut visual, &fixture, index, name);
            // Native patch loader, independently of comparison's readonly state.
            assert!(
                matches!(fixture.client.commit_diff(root.to_str().unwrap(), &hash), Err(error) if error == "Sensitive patch hidden. Read-only."),
                "patch disclosed case {index} ({name})"
            );
            assert_eq!(
                fs::read_to_string(root.join("changed.ts")).unwrap(),
                *source
            );
        }
    }
}

#[gpui::test]
fn privacy_benign_matrix_remains_visible_and_copyable(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let hash = git(&root, &["rev-parse", "HEAD"]);
    let (shell, mut visual) = open_commit(&fixture, cx);
    for (index, source) in benign_cases().into_iter().enumerate() {
        fs::write(root.join("changed.ts"), source).unwrap();
        reload(&shell, &mut visual, &hash);
        let editor = visual
            .debug_bounds("commit-editor")
            .unwrap_or_else(|| panic!("benign case {index} hidden"));
        visual.simulate_click(editor.center(), gpui::Modifiers::default());
        visual.simulate_keystrokes("ctrl-a ctrl-c");
        assert_eq!(
            visual
                .read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref(),
            Some(source),
            "benign case {index} changed"
        );
        assert_eq!(fs::read_to_string(root.join("changed.ts")).unwrap(), source);
    }
}

#[gpui::test]
fn privacy_benign_committed_matrix_keeps_snapshot_and_patch_visible(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let base = git(&root, &["rev-parse", "HEAD"]);
    let (shell, mut visual) = open_commit(&fixture, cx);
    for (index, source) in benign_cases().into_iter().enumerate() {
        git(&root, &["checkout", "-q", "-B", "privacy-benign", &base]);
        fs::write(root.join("changed.ts"), source).unwrap();
        git(&root, &["add", "changed.ts"]);
        git(&root, &["commit", "-qm", "synthetic references"]);
        let hash = git(&root, &["rev-parse", "HEAD"]);
        reload(&shell, &mut visual, &hash);
        let editor = visual
            .debug_bounds("commit-editor")
            .unwrap_or_else(|| panic!("committed benign case {index} hidden"));
        visual.simulate_click(editor.center(), gpui::Modifiers::default());
        visual.simulate_keystrokes("ctrl-a ctrl-c");
        assert_eq!(
            visual
                .read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref(),
            Some(source),
            "committed benign case {index} changed"
        );
        assert!(
            fixture
                .client
                .commit_diff(root.to_str().unwrap(), &hash)
                .is_ok(),
            "benign patch {index} hidden"
        );
    }
}

#[test]
fn privacy_diff_source_streams_preserve_key_values_and_references() {
    for (index, (name, source)) in secret_cases().into_iter().enumerate() {
        for prefix in ['+', '-'] {
            let diff = format!(
                "diff --git a/file b/file\nindex 1111111..2222222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n{}\n",
                source
                    .lines()
                    .map(|line| format!("{prefix}{line}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            assert!(
                guard::sensitive_patch(&diff),
                "diff missed {index} ({name}) / {prefix}"
            );
        }
    }
    for (index, source) in benign_cases().into_iter().enumerate() {
        let diff = format!(
            "diff --git a/file b/file\nindex 1111111..2222222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-safe source\n{}\n",
            source
                .lines()
                .map(|line| format!("+{line}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(!guard::sensitive_patch(&diff), "benign diff hidden {index}");
    }
    for diff in [
        "diff --git a/PASSWORD=owned@! b/plain\n@@ -0,0 +1 @@\n+safe\n",
        "diff --git a/first b/first\n@@ -1 +1 @@\n+const password = 'owned@!';\ndiff --git a/second b/second\n@@ -1 +1 @@\n+const token = getToken();\n",
        "diff --git a/file b/file\nmalformed PASSWORD=owned@!\n",
        "diff --git a/file b/file\n@@ -19,4 +19,4 @@ const PASSWORD = 'owned@!';\n+safe source\n",
        "diff --git a/file b/file\nPASSWORD =\nowned@!\n",
    ] {
        assert!(guard::sensitive_patch(diff));
    }
}

#[gpui::test]
fn privacy_commit_message_literals_stay_out_of_header_and_clipboard(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let (shell, mut visual) = open_commit(&fixture, cx);
    for (index, message) in [
        "process.env[\"DATABASE_PASSWORD\"] = 'owned@!';",
        "{\"PASSWORD\": \"owned@!\"}",
    ]
    .into_iter()
    .enumerate()
    {
        fs::write(
            root.join("changed.ts"),
            format!("export const value = {};\n", index + 3),
        )
        .unwrap();
        git(&root, &["add", "changed.ts"]);
        git(&root, &["commit", "-qm", message]);
        let hash = git(&root, &["rev-parse", "HEAD"]);
        reload(&shell, &mut visual, &hash);
        assert_private(&shell, &mut visual, &fixture, index, "commit-message");
    }
    fs::write(root.join("changed.ts"), "export const value = 5;\n").unwrap();
    git(&root, &["add", "changed.ts"]);
    git(&root, &["commit", "-qm", "const token = getToken();"]);
    let hash = git(&root, &["rev-parse", "HEAD"]);
    reload(&shell, &mut visual, &hash);
    assert!(
        visual.debug_bounds("commit-editor").is_some(),
        "benign header reference hidden"
    );
}

#[gpui::test]
fn privacy_unchanged_secret_in_git_hunk_header_never_reaches_patch(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let source = format!(
        "const PASSWORD = 'owned@!';\n{}old\n",
        (0..20)
            .map(|n| format!("// filler {n}\n"))
            .collect::<String>()
    );
    fs::write(root.join("changed.ts"), &source).unwrap();
    git(&root, &["add", "changed.ts"]);
    git(&root, &["commit", "-qm", "synthetic safe parent"]);
    fs::write(root.join("changed.ts"), source.replace("old\n", "new\n")).unwrap();
    git(&root, &["add", "changed.ts"]);
    git(&root, &["commit", "-qm", "synthetic distant edit"]);
    let hash = git(&root, &["rev-parse", "HEAD"]);
    let patch = git(&root, &["show", "--format=", "HEAD"]);
    assert!(
        patch
            .lines()
            .any(|line| line.starts_with("@@") && line.contains("owned@!")),
        "fixture must put the canary in Git's hunk header"
    );
    let (shell, mut visual) = open_commit(&fixture, cx);
    assert_private(&shell, &mut visual, &fixture, 0, "hunk-header");
    assert!(
        matches!(fixture.client.commit_diff(root.to_str().unwrap(), &hash), Err(error) if error == "Sensitive patch hidden. Read-only.")
    );
}
