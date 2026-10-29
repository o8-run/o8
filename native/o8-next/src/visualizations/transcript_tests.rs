use super::*;
use serde_json::json;
fn reference(n: usize, created: &str) -> Reference {
    Reference::parse(
        &json!({"kind":"o8-visualization","id":format!("vis-00000000-0000-0000-0000-{n:012}"),
        "title":"Saved chart","height":320,"createdAt":created}),
    )
    .unwrap()
}
fn message(id: &str, role: &str, timestamp: Option<f64>) -> Entry {
    serde_json::from_value(json!({"id":id,"role":role,"text":"Reply", "timestamp":timestamp}))
        .unwrap()
}
#[test]
fn placement_keeps_embedded_reference_and_updates_on_its_message() {
    let original = reference(1, "2026-10-01T00:00:02.000Z");
    let mut newer = reference(2, "2026-10-01T00:00:04.000Z");
    newer.root_id = Some(original.id.clone());
    newer.version = Some(2);
    let mut producing = message("producing", "assistant", None);
    producing.tools = Some(vec![
        json!({"name":"o8_html_render","result":json!({"visualization":original}).to_string()}),
    ]);
    let messages = vec![producing, message("tail", "assistant", None)];
    let (buckets, anchors) = place(
        &[original.clone(), newer.clone()],
        &messages,
        &Anchors::new(),
    );
    assert_eq!(buckets["producing"], vec![newer.clone()]);
    assert_eq!(anchors[original.state_id()], "producing");
    assert_eq!(merge(vec![original], &buckets["producing"]), vec![newer]);
}
#[test]
fn placement_uses_latest_timestamp_at_or_before_creation_with_milliseconds() {
    let r = reference(1, "2026-10-01T00:00:02.125Z");
    let time = created_at_ms(&r.created_at).unwrap();
    let messages = vec![
        message("first", "assistant", Some(time - 1.)),
        message("exact", "assistant", Some(time)),
        message("later", "assistant", Some(time + 1.)),
    ];
    let (buckets, _) = place(&[r], &messages, &Anchors::new());
    assert_eq!(buckets.keys().collect::<Vec<_>>(), vec!["exact"]);
}
#[test]
fn placement_moves_forward_to_assistant_without_crossing_another_user() {
    let r = reference(1, "2026-10-01T00:00:02.000Z");
    let time = created_at_ms(&r.created_at).unwrap();
    let messages = vec![
        message("ask", "user", Some(time - 1.)),
        message("tool", "tool", Some(time)),
        message("answer", "assistant", Some(time + 1.)),
    ];
    let (buckets, _) = place(&[r.clone()], &messages, &Anchors::new());
    assert!(buckets.contains_key("answer"));
    let messages = vec![
        messages[0].clone(),
        message("next-ask", "user", Some(time + 1.)),
        messages[2].clone(),
    ];
    assert!(
        place(&[r], &messages, &Anchors::new())
            .0
            .contains_key("ask")
    );
}
#[test]
fn placement_without_clocks_anchors_tail_across_polls_growth_and_partial_pages() {
    let r = reference(1, "2026-10-01T00:00:02.000Z");
    let mut messages = vec![
        message("ask", "user", None),
        message("answer", "assistant", None),
    ];
    let (buckets, anchors) = place(&[r.clone()], &messages, &Anchors::new());
    assert!(buckets.contains_key("answer"));
    messages.push(message("later", "assistant", None));
    let mut revision = r.clone();
    revision.id = reference(2, &r.created_at).id;
    revision.root_id = Some(r.id);
    revision.version = Some(2);
    let (buckets, anchors) = place(&[revision.clone()], &messages, &anchors);
    assert!(buckets.contains_key("answer"));
    assert!(place(&[revision], &messages[2..], &anchors).0.is_empty());
}
#[test]
fn placement_and_merge_attach_only_highest_root_revision() {
    let r = reference(1, "2026-10-01T00:00:02.000Z");
    let mut newer = reference(2, &r.created_at);
    newer.root_id = Some(r.id.clone());
    newer.version = Some(3);
    let messages = vec![message("reply", "assistant", None)];
    let (buckets, _) = place(&[newer.clone(), r], &messages, &Anchors::new());
    let mut rows = crate::model::render_tree(&messages);
    attach(&mut rows, &buckets);
    let Row::Message { nodes, .. } = &rows[0] else {
        panic!()
    };
    assert_eq!(
        nodes.iter().filter(|n| n.kind == "visualization").count(),
        1
    );
    assert_eq!(nodes.last().unwrap().data.as_ref().unwrap()["id"], newer.id);
}

#[test]
fn placement_waits_for_missing_older_turns_instead_of_crossing_a_user_prompt() {
    let r = reference(1, "2026-10-01T00:00:00.000Z");
    let time = created_at_ms(&r.created_at).unwrap();
    let messages = vec![
        message("system", "system", Some(time + 1.)),
        message("ask", "user", Some(time + 2.)),
        message("answer", "assistant", Some(time + 3.)),
    ];
    let (buckets, anchors) = place(&[r], &messages, &Anchors::new());
    assert!(buckets.is_empty());
    assert!(anchors.is_empty());
}
