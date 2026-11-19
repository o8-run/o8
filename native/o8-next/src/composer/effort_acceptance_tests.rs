//! #6533 acceptance through the real composer: the effort a queued turn
//! carries after the first Settings editor save on a fresh profile, an
//! explicit choice, and a later editor omission. The real queue route stores
//! the outbound request; nothing dispatches it to a provider.
use super::*;

const THREAD: &str = "thoughts-composer-codex";
const NATIVE: &str = "/api/panel/operator-defaults";

/// Reopens the Codex thread, so routing is read again, then queues one turn and
/// returns the routing the composer sent with it.
fn send(surface: &gpui::Entity<Surface>, text: &str, cx: &mut VisualTestContext) -> Value {
    surface.update(cx, |s, cx| s.select("thoughts-composer-first".into(), cx));
    cx.run_until_parked();
    surface.update(cx, |s, cx| s.select(THREAD.into(), cx));
    cx.run_until_parked();
    draw(cx);
    surface.update_in(cx, |s, window, cx| {
        s.send_next = true;
        s.composer.read(cx).focus.focus(window);
    });
    cx.simulate_input(text);
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    surface.read_with(cx, |s, _| {
        let items = s.queue["items"].as_array().expect("queued turns");
        let item = items
            .iter()
            .find(|item| item["payload"]["text"] == text)
            .unwrap_or_else(|| panic!("queued turn {text}"));
        item["payload"]["routing"].clone()
    })
}

fn native(client: &Client) -> Value {
    client.get(NATIVE, &[("include", "native")]).unwrap()
}

fn save(client: &Client, mut body: Value) {
    body["settingsTomlRevision"] = native(client)["settingsToml"]["revision"].clone();
    let url = client.url(&format!("{NATIVE}?include=native")).unwrap();
    client
        .request("POST", &url)
        .send_json(body)
        .expect("settings save");
}

/// Saves the text the editor shows, changed only by `edit`.
fn editor(client: &Client, edit: impl Fn(&str) -> String) {
    let shown = native(client)["settingsToml"]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    save(client, json!({"settingsToml": edit(&shown)}));
}

fn source(client: &Client) -> (String, String) {
    let values: Value = client.get(NATIVE, &[("include", "values")]).unwrap();
    (
        values["values"]["thinkingEffort"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        values["sources"]["thinkingEffort"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}

#[gpui::test]
fn the_composer_sends_the_catalogue_effort_after_a_first_editor_save(cx: &mut TestAppContext) {
    let fixture = Fixture::with_args(&["--composer-loaded", "--composer-codex"]);
    let client = fixture.client.clone();
    let catalogue: Value = client.get("/api/mobile/orchestrator/models", &[]).unwrap();
    let entry = catalogue["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == "codex")
        .and_then(|agent| {
            agent["models"]
                .as_array()?
                .iter()
                .find(|model| model["id"] == "gpt-5.5")
                .cloned()
        })
        .expect("gpt-5.5 catalogue entry");
    let implicit = entry["defaultEffort"].as_str().unwrap().to_owned();
    assert!(
        !entry["efforts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e == "max")
    );
    let (surface, cx) = open(cx, &fixture);

    let fresh = send(&surface, "Fresh profile", cx);
    assert_eq!(fresh["model"], "gpt-5.5");
    assert_eq!(fresh["effort"], implicit.as_str(), "fresh profile");

    // The first save of the text the editor shows, then an unrelated field.
    editor(&client, |shown| {
        if shown.contains("parallel_cap = ") {
            shown
                .lines()
                .map(|line| {
                    if line.starts_with("parallel_cap = ") {
                        "parallel_cap = 9"
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            format!("{shown}\n[operator]\nparallel_cap = 9\n")
        }
    });
    save(&client, json!({"parallelCap": 7}));
    assert_eq!(
        source(&client).1,
        "default",
        "editor save keeps the default unset"
    );
    let saved = send(&surface, "After first editor save", cx);
    assert_eq!(
        saved["effort"],
        implicit.as_str(),
        "after first editor save"
    );

    // An explicit choice is sent as chosen, even where it differs from the default.
    let explicit = if implicit == "xhigh" {
        "medium"
    } else {
        "xhigh"
    };
    save(&client, json!({"thinkingEffort": explicit}));
    save(&client, json!({"parallelCap": 6}));
    assert_eq!(source(&client), (explicit.to_owned(), "file".to_owned()));
    let chosen = send(&surface, "Explicit effort", cx);
    assert_eq!(chosen["effort"], explicit, "explicit effort");

    // Removing the line in the editor returns to the catalogue default.
    editor(&client, |shown| {
        shown
            .lines()
            .filter(|line| !line.starts_with("thinking_effort = "))
            .collect::<Vec<_>>()
            .join("\n")
    });
    assert_eq!(source(&client).1, "default", "re-omission");
    let omitted = send(&surface, "After re-omission", cx);
    assert_eq!(omitted["effort"], implicit.as_str(), "after re-omission");
}
