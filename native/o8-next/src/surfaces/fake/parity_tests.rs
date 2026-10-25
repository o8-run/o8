//! Parity measurements through the real shell and production-route fixture host.
use crate::shell::test_support::*;
use crate::shell::*;

#[gpui::test]
fn parity_capture_real_shell(cx: &mut TestAppContext) {
    let manifest: Value = serde_json::from_slice(
        &fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/parity/surfaces.json"),
        )
        .expect("parity harness must map every registered surface"),
    )
    .unwrap();
    assert_eq!(
        manifest["surfaces"].as_array().unwrap().len(),
        registrations().len() - 1
    );
    assert_eq!(manifest["sizes"], json!([[1024, 720], [1440, 900]]));
    let origin = std::env::var("O8_PARITY_ORIGIN").ok();
    let fixture = origin.is_none().then(Fixture::new);
    let client = origin
        .map(|origin| {
            Client::authenticated(&origin, std::env::var("O8_NEXT_API_TOKEN").ok()).unwrap()
        })
        .unwrap_or_else(|| fixture.as_ref().unwrap().client.clone());
    let root = std::env::var_os("O8_PARITY_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| fixture.as_ref().unwrap().root.clone());
    let state = std::env::var_os("O8_PARITY_STATE")
        .map(|file| State::load(&PathBuf::from(file)).unwrap())
        .unwrap_or_default();
    let (shell, mut visual) = open(client, root.join("gpui-state.json"), state, cx);
    if fixture.is_some() {
        ready(&shell, &mut visual);
    } else {
        for _ in 0..30 {
            visual.run_until_parked();
            draw(&mut visual);
        }
    }
    assert!(shell.read_with(&visual, |s, _| s.connected));
    if let Ok(id) = std::env::var("O8_PARITY_SURFACE") {
        let scenario = manifest["surfaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap();
        if let Some(command) = scenario["nativeCommand"].as_str() {
            visual.simulate_keystrokes("ctrl-k");
            let query = command
                .to_lowercase()
                .chars()
                .map(|c| {
                    if c == ' ' {
                        "space".into()
                    } else {
                        c.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            visual.simulate_keystrokes(&query);
            visual.simulate_keystrokes("enter");
        }
        if let Some(keys) = scenario["nativeKeys"].as_str() {
            visual.simulate_keystrokes(
                &keys
                    .replace("ctrl+comma", "ctrl-,")
                    .replace("ctrl+k", "ctrl-k"),
            );
        }
        for _ in 0..40 {
            visual.run_until_parked();
            draw(&mut visual);
            shell.update(&mut visual, |s, cx| {
                if let Some(tab) = s.active()
                    && let Some(content) = s.content.get(&s.key(&tab))
                {
                    content.tick(false, cx);
                }
            });
        }
        let mut metrics = serde_json::Map::new();
        for (name, spec) in manifest["elements"].as_object().unwrap() {
            let bounds = spec["native"].as_str().and_then(|selector| {
                visual.debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
            });
            metrics.insert(name.clone(), bounds.map(|bounds| json!({
                "x": f32::from(bounds.origin.x), "y": f32::from(bounds.origin.y),
                "width": f32::from(bounds.size.width), "height": f32::from(bounds.size.height),
                "fontSize": null, "fontWeight": null,
                "paddingTop": null, "paddingRight": null, "paddingBottom": null, "paddingLeft": null,
            })).unwrap_or(Value::Null));
        }
        let present = scenario["nativeSelectors"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|selector| {
                let text = selector.as_str().unwrap();
                visual
                    .debug_bounds(Box::leak(text.to_owned().into_boxed_str()))
                    .map(|_| text)
            })
            .collect::<Vec<_>>();
        fs::write(root.join("native-metrics.json"), serde_json::to_vec_pretty(&json!({
            "metrics": metrics, "present": present,
            "provenance": "GPUI TestAppContext bounds; test text system, separate from pixel capture",
        })).unwrap()).unwrap();
    } else {
        assert!(visual.debug_bounds("workspace-0").is_some());
    }
}
