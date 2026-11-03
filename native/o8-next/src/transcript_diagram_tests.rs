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
                ..Default::default()
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
                ..Default::default()
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

fn assert_no_overlaps(scene: &Scene, width: f32) {
    assert!(!scene.boxes.is_empty() && scene.height > 0. && scene.width <= width + 0.01);
    for (i, a) in scene.boxes.iter().enumerate() {
        assert!(
            a.x >= -0.01 && a.x + a.w <= width + 0.01,
            "{a:?} inside {width}"
        );
        for b in &scene.boxes[i + 1..] {
            assert!(
                a.x + a.w <= b.x + 0.01
                    || b.x + b.w <= a.x + 0.01
                    || a.y + a.h <= b.y + 0.01
                    || b.y + b.h <= a.y + 0.01,
                "{a:?} overlaps {b:?}"
            );
        }
    }
}

#[test]
fn mermaid_parses_and_lays_out_state_diagrams() {
    let source = "stateDiagram-v2\n[*] --> Still\nStill --> [*]\nStill --> Moving : push\nMoving --> Still\nMoving --> Crash\nCrash --> [*]\nstate \"Waiting for input\" as Wait\nCrash --> Wait\nstate pick <<choice>>\nWait --> pick\npick --> Still : retry\nstate split <<fork>>\nMoving --> split\nMoving : rolling\nMoving : downhill\nnote right of Crash : Ouch\nclassDef bad fill:#f00\nclass Crash bad";
    let Diagram::Flow { lr, nodes, edges } = parse(source).unwrap() else {
        panic!("state")
    };
    assert!(!lr);
    let find = |id: &str| nodes.iter().position(|n| n.id == id).unwrap();
    assert_eq!(nodes[find("root_start")].shape, Shape::Start);
    assert_eq!(nodes[find("root_end")].shape, Shape::End);
    assert_eq!(nodes[find("pick")].shape, Shape::Choice);
    assert_eq!(nodes[find("split")].shape, Shape::Bar);
    assert_eq!(nodes[find("Wait")].label, "Waiting for input");
    assert_eq!(nodes[find("Moving")].label, "rolling");
    assert_eq!(
        nodes[find("Moving")].sections,
        vec![vec!["downhill".to_owned()]]
    );
    let note = nodes.iter().position(|n| n.shape == Shape::Note).unwrap();
    assert_eq!(nodes[note].label, "Ouch");
    assert!(
        edges
            .iter()
            .any(|e| e.from == find("Crash") && e.to == note && e.dashed && !e.arrow)
    );
    assert!(edges.iter().any(|e| e.label == "push" && e.arrow));
    assert_eq!(edges.iter().filter(|e| e.to == find("root_end")).count(), 2);
    let lr = parse("stateDiagram\ndirection LR\n[*] --> A\nA --> B").unwrap();
    assert!(matches!(lr, Diagram::Flow { lr: true, .. }));
    for diagram in [parse(source).unwrap(), lr] {
        for width in [260., 720.] {
            assert_no_overlaps(&layout(&diagram, width), width);
        }
    }
}

#[test]
fn mermaid_parses_and_lays_out_class_diagrams() {
    let source = "classDiagram\nclass Animal {\n  <<abstract>>\n  +String name\n  -int age$\n  +eat(food) bool\n  +sleep()*\n}\nclass Duck~T~\nAnimal <|-- Duck\nAnimal <|-- Fish\nDuck \"1\" *-- \"many\" Egg : lays\nFish o.. Water\nDuck ..> Pond : swims in\nDuck : +quack() void\nnote for Duck \"can fly\"\n<<interface>> Pond";
    let Diagram::Flow { nodes, edges, .. } = parse(source).unwrap() else {
        panic!("class")
    };
    let find = |id: &str| nodes.iter().position(|n| n.id == id).unwrap();
    let animal = &nodes[find("Animal")];
    assert_eq!(animal.shape, Shape::Class);
    assert_eq!(animal.above, vec!["«abstract»".to_owned()]);
    assert_eq!(
        animal.sections,
        vec![
            vec!["+String name".to_owned(), "-int age".to_owned()],
            vec!["+eat(food) : bool".to_owned(), "+sleep()".to_owned()],
        ]
    );
    assert_eq!(nodes[find("Duck")].label, "Duck<T>");
    assert_eq!(
        nodes[find("Duck")].sections[1],
        vec!["+quack() : void".to_owned()]
    );
    assert_eq!(nodes[find("Pond")].above, vec!["«interface»".to_owned()]);
    let inherit = edges
        .iter()
        .find(|e| e.from == find("Animal") && e.to == find("Duck"))
        .unwrap();
    assert_eq!(inherit.marks, [Marker::Triangle, Marker::None]);
    assert!(!inherit.dashed && !inherit.arrow);
    let lays = edges.iter().find(|e| e.label == "lays").unwrap();
    assert_eq!(lays.marks, [Marker::FilledDiamond, Marker::None]);
    assert_eq!(lays.ends, ["1".to_owned(), "many".to_owned()]);
    let water = edges.iter().find(|e| e.to == find("Water")).unwrap();
    assert!(water.dashed);
    assert_eq!(water.marks, [Marker::Diamond, Marker::None]);
    let swims = edges.iter().find(|e| e.label == "swims in").unwrap();
    assert_eq!(swims.marks, [Marker::None, Marker::Arrow]);
    assert!(
        nodes
            .iter()
            .any(|n| n.shape == Shape::Note && n.label == "can fly")
    );
    let diagram = parse(source).unwrap();
    for width in [260., 720.] {
        let scene = layout(&diagram, width);
        assert_no_overlaps(&scene, width);
        assert!(scene.strokes.iter().any(|s| s.marks[0] == Marker::Triangle));
        // Each of the six class boxes is split into title, attributes and methods.
        assert_eq!(scene.rules.len(), 2 * 6);
    }
}

#[test]
fn mermaid_parses_and_lays_out_pie_charts() {
    let source = "pie showData title Pets adopted\n\"Dogs\" : 386\n\"Cats\" : 85.5\n\"Rats\" : 15\n\"Fish\" : 0.5\n\"Dogs\" : 1";
    let Diagram::Pie {
        title,
        show_data,
        slices,
    } = parse(source).unwrap()
    else {
        panic!("pie")
    };
    assert_eq!(title, "Pets adopted");
    assert!(show_data);
    assert_eq!(slices.len(), 4, "a repeated label keeps its first value");
    assert_eq!(slices[0], ("Dogs".to_owned(), 386.));
    assert_eq!(slices[1].1, 85.5);
    let titled = parse("pie\ntitle Key elements\n\"Calcium\" : 42.96\n\"Iron\" : 5").unwrap();
    assert!(
        matches!(&titled, Diagram::Pie { title, show_data: false, .. } if title == "Key elements")
    );
    let diagram = parse(source).unwrap();
    for width in [260., 720.] {
        let scene = layout(&diagram, width);
        assert_eq!(scene.wedges.len(), 3, "a slice under 1% is not drawn");
        let sweep: f32 = scene.wedges.iter().map(|w| w.end - w.start).sum();
        assert!((sweep - std::f32::consts::TAU).abs() < 0.02, "{sweep}");
        assert_eq!(scene.swatches.len(), 4);
        assert!(scene.labels.iter().any(|l| l.text == "Dogs [386]"));
        assert!(scene.labels.iter().any(|l| l.text == "79%"));
        assert!(scene.width <= width + 0.01);
        // The legend never covers the pie, and swatches stack without touching.
        let pie = &scene.wedges[0];
        for (i, (a, _)) in scene.swatches.iter().enumerate() {
            assert!(
                a.x >= pie.cx + pie.r || a.y >= pie.cy + pie.r,
                "swatch {a:?} over the pie"
            );
            for (b, _) in &scene.swatches[i + 1..] {
                assert!(a.y + a.h <= b.y || b.y + b.h <= a.y);
            }
        }
    }
}

#[test]
fn mermaid_new_types_fall_back_on_garbage() {
    for source in [
        "stateDiagram-v2\nA --> ",
        "stateDiagram-v2\nstate Busy {\nA --> B\n}",
        "stateDiagram\n[*] --> A\n--\nB --> C",
        "stateDiagram-v2\nA -> B",
        "stateDiagram-v2\nnote right of A\nnever closed",
        "classDiagram\nAnimal <|-- ",
        "classDiagram\nclass A {\n+x",
        "classDiagram\nnamespace Zoo {\nclass A\n}",
        "classDiagram\nA <-> B ??",
        "classDiagram\njust words here",
        "pie\n1: 2",
        "pie\n\"Dogs\" : -3",
        "pie\n\"Dogs\" : lots",
        "pie title Only a title\nDogs : 3",
        "pie\n\"Unclosed : 3",
    ] {
        assert_eq!(
            parse(source).unwrap_err(),
            ParseError::Unsupported,
            "{source}"
        );
        let node = crate::text::markdown(&format!("```mermaid\n{source}\n```")).remove(0);
        assert!(for_node(&node).is_none(), "{source}");
    }
    let many = format!(
        "stateDiagram-v2\n{}",
        (0..201)
            .map(|i| format!("S{i} --> S{}", i + 1))
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(parse(&many).unwrap_err(), ParseError::Limit);
    let slices = format!(
        "pie\n{}",
        (0..201)
            .map(|i| format!("\"S{i}\" : 1"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(parse(&slices).unwrap_err(), ParseError::Limit);
}

#[test]
fn mermaid_zoom_clamps_drags_and_resets() {
    let mut view = Viewport::default();
    assert_eq!(view.apply((10., 20.)), (10., 20.));
    // Zooming keeps the point under the pointer in place.
    let at = (100., 50.);
    let under = (
        (at.0 - view.pan.0) / view.zoom,
        (at.1 - view.pan.1) / view.zoom,
    );
    view.zoom_at(2., at);
    assert_eq!(view.zoom, 2.);
    let after = view.apply(under);
    assert!((after.0 - at.0).abs() < 0.001 && (after.1 - at.1).abs() < 0.001);
    for _ in 0..40 {
        view.wheel(24., at);
    }
    assert_eq!(view.zoom, MAX_ZOOM);
    for _ in 0..80 {
        view.wheel(-500., (0., 0.));
    }
    assert_eq!(view.zoom, MIN_ZOOM);
    // One mouse-wheel notch (a line, 20px) toward the reader zooms in.
    let mut notch = Viewport::default();
    notch.wheel(20., (0., 0.));
    assert!(notch.zoom > 1.2 && notch.zoom < 1.4, "{}", notch.zoom);
    let pan = view.pan;
    view.drag(12., -7.);
    assert_eq!(view.pan, (pan.0 + 12., pan.1 - 7.));
    view.reset();
    assert_eq!(view, Viewport::default());
    // Plain scrolling is the transcript's, not the diagram's.
    assert!(!zooms(&gpui::Modifiers::default()));
    assert!(zooms(&gpui::Modifiers {
        control: true,
        ..Default::default()
    }));
    assert!(zooms(&gpui::Modifiers {
        platform: true,
        ..Default::default()
    }));
    // Views survive a row update: the transcript keeps a reader's zoom while a reply streams.
    let views = Views::default();
    views.update(0, |view| view.zoom_at(1.5, (0., 0.)));
    let kept = views.clone();
    assert_eq!(kept.get(0).zoom, 1.5);
    assert_eq!(kept.get(1), Viewport::default());
}

#[test]
fn mermaid_edge_labels_clear_other_edges_and_multiplicities() {
    let sources = [
        "classDiagram\nclass Lane {\n+string laneId\n+string status\n}\nclass Packet {\n+string packetId\n+string title\n}\nclass Worker {\n+string runtime\n+string model\n}\nLane \"1\" --> \"*\" Packet : contains\nPacket \"1\" --> \"1\" Worker : assigned to\nWorker \"*\" --> \"1\" Lane : runs in",
        "stateDiagram-v2\n[*] --> Draft\nDraft --> Review : submit\nReview --> Approved : approved\nReview --> Draft : changes requested\nApproved --> [*]",
        "classDiagram\ndirection LR\nAnimal \"1\" <|-- \"many\" Duck : is a\nDuck \"0..1\" o-- \"*\" Egg : lays\nEgg ..> Animal : becomes",
        "flowchart TD; A[Start] --> B{Ready?}; B -->|yes| C([A wider destination]); B -->|no| D[Retry]; D -->|again| B; C -->|restart| A",
    ];
    for source in sources {
        let diagram = parse(source).unwrap();
        for width in [320., 2000.] {
            let scene = layout(&diagram, width);
            let multiplicities: Vec<_> = scene
                .labels
                .iter()
                .filter(|l| l.multiplicity)
                .map(|l| l.rect)
                .collect();
            for &m in &multiplicities {
                for b in &scene.boxes {
                    assert!(!overlap(m, *b), "{source}: multiplicity {m:?} in a box");
                }
            }
            let labels: Vec<_> = scene
                .labels
                .iter()
                .filter(|l| !l.multiplicity && l.edge.is_some())
                .collect();
            assert!(!labels.is_empty(), "{source}");
            for label in labels {
                let own = label.edge.unwrap();
                let rect = label.rect;
                for (index, stroke) in scene.strokes.iter().enumerate() {
                    // Its own line stops at the plate; every other line misses it.
                    let segments = if index == own {
                        stroke.pieces()
                    } else {
                        vec![stroke.points.clone()]
                    };
                    for piece in segments {
                        for pair in piece.windows(2) {
                            assert!(
                                !crosses(rect, pair[0], pair[1]),
                                "{source} at {width}: {:?} {rect:?} crosses edge {index} {pair:?}",
                                label.text
                            );
                        }
                    }
                }
                for &m in &multiplicities {
                    assert!(!overlap(rect, m), "{source}: {:?} covers {m:?}", label.text);
                }
                for b in &scene.boxes {
                    assert!(
                        !overlap(rect, *b),
                        "{source}: {:?} covers {b:?}",
                        label.text
                    );
                }
            }
        }
    }
    // A label centred on its line cuts it in two at the plate.
    let scene = layout(&parse("flowchart TD\nA -->|go| B").unwrap(), 720.);
    let stroke = &scene.strokes[0];
    assert!(stroke.gap.is_some());
    assert_eq!(stroke.pieces().len(), 2);
}

#[test]
fn mermaid_pie_text_contrasts_with_its_slice() {
    let light = Rgba {
        r: 0.95,
        g: 0.95,
        b: 0.95,
        a: 1.,
    };
    let dark = Rgba {
        r: 0.08,
        g: 0.08,
        b: 0.09,
        a: 0.6,
    };
    for fill in [
        Rgba {
            r: 0.31,
            g: 0.5,
            b: 0.93,
            a: 1.,
        },
        Rgba {
            r: 0.97,
            g: 0.85,
            b: 0.3,
            a: 1.,
        },
        Rgba {
            r: 0.75,
            g: 0.78,
            b: 0.85,
            a: 1.,
        },
        Rgba {
            r: 0.4,
            g: 0.78,
            b: 0.4,
            a: 1.,
        },
        Rgba {
            r: 0.1,
            g: 0.1,
            b: 0.4,
            a: 1.,
        },
    ] {
        let text = ink(fill, light, dark);
        assert_eq!(text.a, 1., "translucent ink disappears on a slice");
        assert!(
            contrast(text, fill) >= 3.,
            "{fill:?}: {}",
            contrast(text, fill)
        );
    }
    let scene = layout(
        &parse("pie\n\"Planning\" : 15\n\"Building\" : 45\n\"Review\" : 25\n\"Shipping\" : 15")
            .unwrap(),
        720.,
    );
    let inside: Vec<_> = scene
        .labels
        .iter()
        .filter(|l| l.on_fill.is_some())
        .collect();
    assert_eq!(
        inside.len(),
        4,
        "every slice is wide enough for its percentage"
    );
    assert!(inside.iter().any(|l| l.text == "45%"));
}
