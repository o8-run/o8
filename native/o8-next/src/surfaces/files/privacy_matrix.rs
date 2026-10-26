//! Privacy regression matrix: real authenticated reads, native source and clipboard.
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
fn benign_cases() -> [&'static str; 29] {
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
        "import { getToken } from './auth';\n",
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

#[gpui::test]
fn privacy_matrix_reaches_real_shell_without_editor_clipboard_or_log_disclosure(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("matrix.txt");
    fs::write(&file, "safe source").unwrap();
    let (shell, mut visual) = open_file("matrix.txt", &fixture, cx);
    for (index, (name, source)) in secret_cases().into_iter().enumerate() {
        fs::write(&file, &source).unwrap();
        reload(&shell, &mut visual, "matrix.txt");
        visual.write_to_clipboard(gpui::ClipboardItem::new_string("safe clipboard".into()));
        click(&mut visual, "file-copy");
        draw(&mut visual);
        assert!(
            shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
                Some(Content::Files(view)) => view.read(cx).test_hidden_source(cx),
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
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            source,
            "read modified file in case {index}"
        );
    }
}
#[gpui::test]
fn privacy_benign_matrix_remains_visible_and_copyable(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("references.txt");
    fs::write(&file, "safe source").unwrap();
    let (shell, mut visual) = open_file("references.txt", &fixture, cx);
    for (index, source) in benign_cases().into_iter().enumerate() {
        fs::write(&file, source).unwrap();
        reload(&shell, &mut visual, "references.txt");
        let source_view = visual
            .debug_bounds("file-source")
            .unwrap_or_else(|| panic!("benign case {index} hidden"));
        visual.simulate_click(source_view.center(), gpui::Modifiers::default());
        visual.simulate_keystrokes("ctrl-c");
        assert_eq!(
            visual
                .read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref(),
            Some(source),
            "benign case {index} changed"
        );
    }
}

fn reload(shell: &Entity<Shell>, visual: &mut VisualTestContext, path: &str) {
    let input = visual.debug_bounds("file-path").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_keystrokes("ctrl-a");
    visual.simulate_input(path);
    visual.simulate_keystrokes("enter");
    wait_file(shell, visual, path, false);
}
