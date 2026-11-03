use super::*;

#[test]
fn mermaid_fences_record_closed_vs_unfinished() {
    for language in ["mermaid", "rust", "diff", ""] {
        let open = format!("```{language}\nflowchart TD\nA-->B");
        let unfinished = crate::text::markdown(&open).remove(0);
        let closed = crate::text::markdown(&format!("{open}\n```")).remove(0);
        assert!(!unfinished.fence_closed);
        assert!(closed.fence_closed, "{language}");
        assert_eq!(unfinished.kind, closed.kind);
        assert_eq!(unfinished.runs, closed.runs);
    }
    let nested = crate::text::markdown("````mermaid\nflowchart TD\nA-->B\n```\n````").remove(0);
    assert!(nested.fence_closed);
    assert!(nested.runs[0].text.ends_with("```"));
    let still_open = crate::text::markdown("```mermaid\nflowchart TD\nA-->B\n```more").remove(0);
    assert!(!still_open.fence_closed);
    assert!(still_open.runs[0].text.ends_with("```more"));
}

#[test]
fn mermaid_parses_flowchart_and_graph_shapes_and_labels() {
    for header in ["flowchart TD", "graph LR"] {
        let source = format!(
            "{header}\nA[Start] -->|ready| B{{Choose}}\nB -- yes --> C(Work)\nC --> D([Done])\nD --> E((End))\nE --> F[[Step]]\nF --> G[(Store)]\nG --> H{{{{Prepare}}}}\nH --> I[/Input/]\nI --> J(((Stop)))"
        );
        let Diagram::Flow { lr, nodes, edges } = parse(&source).unwrap() else {
            panic!("flowchart")
        };
        assert_eq!(lr, header.ends_with("LR"));
        assert_eq!(nodes.len(), 10);
        assert_eq!(edges.len(), 9);
        assert_eq!(nodes[0].label, "Start");
        assert_eq!(nodes[1].shape, Shape::Diamond);
        assert_eq!(nodes[9].shape, Shape::DoubleCircle);
        assert_eq!(edges[0].label, "ready");
        assert_eq!(edges[1].label, "yes");
    }
}

#[test]
fn mermaid_parses_sequence_participants_messages_and_notes() {
    let Diagram::Sequence { participants, events } = parse("sequenceDiagram\nparticipant A as Client\nparticipant B as Service\nA->>B: Request\nB-->>A: Response\nNote over A,B: Shared\nNote right of B: Ready").unwrap() else { panic!("sequence") };
    assert_eq!(participants.len(), 2);
    assert_eq!(participants[0].label, "Client");
    assert_eq!(events.len(), 4);
    assert!(matches!(&events[1], Event::Message(e) if e.dashed && e.label == "Response"));
    assert!(matches!(&events[2], Event::Note { from: 0, to: 1, label, .. } if label == "Shared"));
}

#[test]
fn mermaid_layout_node_boxes_do_not_overlap() {
    let diagram = Diagram::Flow {
        lr: false,
        nodes: (0..4)
            .map(|i| Vertex {
                id: format!("N{i}"),
                label: format!("Node {i}"),
                shape: Shape::Rect,
            })
            .collect(),
        edges: [(0, 1), (0, 2), (1, 3), (2, 3), (3, 0)]
            .into_iter()
            .map(|(from, to)| Edge {
                from,
                to,
                label: if from == 0 {
                    format!("branch-{to}")
                } else {
                    String::new()
                },
                dashed: false,
                arrow: true,
            })
            .collect(),
    };
    for width in [220., 720.] {
        let scene = layout(&diagram, width);
        let first = scene
            .labels
            .iter()
            .find(|label| label.text == "branch-1")
            .unwrap();
        let second = scene
            .labels
            .iter()
            .find(|label| label.text == "branch-2")
            .unwrap();
        assert_ne!(
            first.rect.center(),
            second.rect.center(),
            "branch labels stay distinct"
        );
        assert_eq!(scene.boxes.len(), 4);
        assert!(scene.height > 0. && scene.width <= width);
        for (i, a) in scene.boxes.iter().enumerate() {
            assert!(a.x >= 0. && a.x + a.w <= width + 0.01);
            for b in &scene.boxes[i + 1..] {
                assert!(
                    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
                );
            }
        }
    }
}

#[test]
fn mermaid_garbage_falls_back_without_partial_diagrams() {
    for source in [
        "garbage",
        "flowchart TD\nA -->",
        "flowchart TD\nA-->B\nunknown syntax!",
        "sequenceDiagram\nA->>B",
        "sequenceDiagram\nloop forever",
        "pie\n1: 2",
        "flowchart TD\nA[unterminated",
        "flowchart TD\nA-->B trailing",
    ] {
        assert_eq!(
            parse(source).unwrap_err(),
            ParseError::Unsupported,
            "{source}"
        );
        let node = crate::text::markdown(&format!("```mermaid\n{source}\n```")).remove(0);
        assert!(for_node(&node).is_none());
        assert_eq!(node.runs[0].text, source);
    }
}

#[test]
fn mermaid_oversize_falls_back_before_layout() {
    let cases = [
        format!(
            "sequenceDiagram\n{}",
            (0..201)
                .map(|i| format!("participant P{i}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        format!(
            "flowchart TD\n{}",
            (0..201)
                .map(|i| format!("N{i}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        format!("flowchart TD\n{}", "A-->B\n".repeat(201)),
        format!("sequenceDiagram\n{}", "A->>B: next\n".repeat(201)),
        format!("flowchart TD\nA[{}]", "x".repeat(70_000)),
    ];
    for source in cases {
        assert_eq!(parse(&source).unwrap_err(), ParseError::Limit);
        let node = crate::text::markdown(&format!("```mermaid\n{source}\n```")).remove(0);
        assert!(for_node(&node).is_none());
    }
    assert!(parse(&format!("flowchart TD\n{}", "A-->B\n".repeat(200))).is_ok());
    assert!(parse(&format!("sequenceDiagram\n{}", "A->>B: next\n".repeat(200))).is_ok());
}

#[test]
fn mermaid_streaming_fence_stays_code_until_closed() {
    let source = "```mermaid\nflowchart TD\nA-->B\n```";
    for (end, _) in source.char_indices().skip(1) {
        let nodes = crate::text::markdown(&source[..end]);
        for node in nodes {
            assert!(for_node(&node).is_none(), "prefix {end}");
        }
    }
    let node = crate::text::markdown(source).remove(0);
    assert_eq!(node.kind, "code-block");
    assert!(for_node(&node).is_some());
    let mut transcript = crate::stream::Transcript::new(
        serde_json::from_value(serde_json::json!({
            "sessionKey":"llm-chat:diagram", "transcript":[],
        }))
        .unwrap(),
    );
    let mut count = 0;
    for (seq, ch) in source.chars().enumerate() {
        count += ch.len_utf8();
        transcript.apply(&serde_json::json!({
            "channel":"orchestrator", "event":"output", "seq":seq+1,
            "data":{"threadId":"diagram", "assistantMessageId":"reply", "text":ch.to_string()},
        }));
        for row in &transcript.rows {
            if let crate::model::Row::Message { id, nodes, .. } = row {
                assert_eq!(id, "reply");
                for node in nodes {
                    assert_eq!(
                        for_node(node).is_some(),
                        count == source.len(),
                        "stream prefix {count}"
                    );
                }
            }
        }
    }
    assert!(transcript.rows.iter().any(|row| matches!(row,
        crate::model::Row::Message { nodes, .. } if nodes.iter().any(|node| for_node(node).is_some())
    )));
}

fn normal_box(rect: BoxRect, lr: bool) -> BoxRect {
    if lr {
        BoxRect {
            x: rect.y,
            y: rect.x,
            w: rect.h,
            h: rect.w,
        }
    } else {
        rect
    }
}
fn normal_point((x, y): (f32, f32), lr: bool) -> (f32, f32) {
    if lr { (y, x) } else { (x, y) }
}
fn overlaps(a: f32, b: f32, c: f32, d: f32) -> bool {
    a.max(b).min(c.max(d)) - a.min(b).max(c.min(d)) > 0.001
}
fn shared_segment(a: &[(f32, f32)], b: &[(f32, f32)]) -> bool {
    a.windows(2).any(|a| {
        b.windows(2).any(|b| {
            ((a[0].0 - a[1].0).abs() < 0.001
                && (b[0].0 - b[1].0).abs() < 0.001
                && (a[0].0 - b[0].0).abs() < 0.001
                && overlaps(a[0].1, a[1].1, b[0].1, b[1].1))
                || ((a[0].1 - a[1].1).abs() < 0.001
                    && (b[0].1 - b[1].1).abs() < 0.001
                    && (a[0].1 - b[0].1).abs() < 0.001
                    && overlaps(a[0].0, a[1].0, b[0].0, b[1].0))
        })
    })
}

#[test]
fn mermaid_back_edges_stay_outside_nodes_and_share_no_segments() {
    for (header, lr) in [("flowchart TD", false), ("graph LR", true)] {
        let diagram = parse(&format!("{header}; A[Start] --> B{{Ready?}}; B -->|yes| C([A wider destination]); B -->|no| D[Retry]; D --> B; C --> A; D --> A; B --> B")).unwrap();
        let scene = layout(&diagram, 2000.);
        let boxes: Vec<_> = scene.boxes.iter().map(|&r| normal_box(r, lr)).collect();
        let paths: Vec<Vec<_>> = scene
            .strokes
            .iter()
            .map(|s| s.points.iter().map(|&p| normal_point(p, lr)).collect())
            .collect();
        for (index, &(from, to)) in [(3, 1), (2, 0), (3, 0), (1, 1)].iter().enumerate() {
            let path = &paths[index + 3];
            let right = boxes.iter().map(|r| r.x + r.w).fold(0f32, f32::max);
            assert!(
                path.iter().any(|p| p.0 > right + 12.),
                "{header}: return edge needs an outside lane"
            );
            assert!((path[0].0 - (boxes[from].x + boxes[from].w)).abs() < 0.001);
            assert!((path.last().unwrap().0 - (boxes[to].x + boxes[to].w)).abs() < 0.001);
            assert!(
                scene.strokes[index + 3].arrow,
                "arrowhead belongs at the target"
            );
            for pair in path.windows(2) {
                for r in &boxes {
                    let horizontal = (pair[0].1 - pair[1].1).abs() < 0.001;
                    let hits = if horizontal {
                        pair[0].1 > r.y + 0.001
                            && pair[0].1 < r.y + r.h - 0.001
                            && overlaps(pair[0].0, pair[1].0, r.x, r.x + r.w)
                    } else {
                        pair[0].0 > r.x + 0.001
                            && pair[0].0 < r.x + r.w - 0.001
                            && overlaps(pair[0].1, pair[1].1, r.y, r.y + r.h)
                    };
                    assert!(!hits, "{header}: return edge crosses {r:?}: {pair:?}");
                }
            }
        }
        for (index, path) in paths.iter().enumerate() {
            for other in &paths[index + 1..] {
                assert!(
                    !shared_segment(path, other),
                    "{header}: edges share a segment: {path:?} / {other:?}"
                );
            }
        }
    }
}

#[test]
fn mermaid_rank_gaps_are_compact_and_height_fits_content() {
    for (header, lr) in [("flowchart TD", false), ("graph LR", true)] {
        for (edge, max_gap) in [("-->", 41.), ("-->|ready|", if lr { 84. } else { 61. })] {
            let scene = layout(
                &parse(&format!(
                    "{header}; A[Start] {edge} B{{Ready?}}; B --> C([Done])"
                ))
                .unwrap(),
                2000.,
            );
            let boxes: Vec<_> = scene.boxes.iter().map(|&r| normal_box(r, lr)).collect();
            let first_gap = boxes[1].y - boxes[0].y - boxes[0].h;
            let second_gap = boxes[2].y - boxes[1].y - boxes[1].h;
            assert!(
                (39. ..=max_gap).contains(&first_gap),
                "{header}: first gap {first_gap}"
            );
            assert!(
                (39. ..=41.).contains(&second_gap),
                "{header}: second gap {second_gap}"
            );
            if !lr {
                let bottom = scene.boxes.iter().map(|r| r.y + r.h).fold(0f32, f32::max);
                assert!(
                    (scene.height - bottom - 24.).abs() < 0.001,
                    "card has no unused trailing rank gap"
                );
            }
        }
    }
}
