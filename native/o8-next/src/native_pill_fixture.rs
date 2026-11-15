//! Linux raster fixture entry point for the dock panel (moved from native_pill.rs).
#[cfg(target_os = "linux")]
use super::{Pill, Snapshot};
#[cfg(target_os = "linux")]
use gpui::{Application, Bounds, WindowBounds, WindowOptions, point, prelude::*, px, size};

/// Explicit fixture entry point for the isolated Linux display capture harness.
/// It uses the production renderer, no server, capture device or input simulation.
pub(crate) fn try_fixture(args: &[String]) -> Result<bool, String> {
    if args.first().map(String::as_str) != Some("--pill-fixture") {
        return Ok(false);
    }
    #[cfg(not(target_os = "linux"))]
    return Err("Pill raster fixtures require an isolated Linux display".into());
    #[cfg(target_os = "linux")]
    {
        let state = args
            .get(1)
            .filter(|_| args.len() == 2)
            .ok_or("Expected a pill fixture state")?
            .clone();
        if ![
            "idle",
            "requesting-mic",
            "recording",
            "transcribing",
            "polishing",
            "success",
            "error",
        ]
        .contains(&state.as_str())
        {
            return Err("Unknown pill fixture state".into());
        }
        Application::new().run(move |cx| {
            cx.open_window(
                WindowOptions {
                    focus: false,
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(520.), px(120.)),
                    ))),
                    titlebar: None,
                    ..Default::default()
                },
                |_, cx| {
                    cx.new(|_| {
                        let mut pill = Pill::default();
                        pill.apply(Snapshot {
                            state,
                            audio_level: 0.7,
                            duration_ms: 6500,
                            pasted_text: Some("Delivered fixture words".into()),
                            error: Some("Microphone unavailable".into()),
                            ..Default::default()
                        });
                        pill.motion = crate::motion::Transition::settled(160, pill.target);
                        pill
                    })
                },
            )
            .unwrap();
        });
        Ok(true)
    }
}
