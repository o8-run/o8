mod render_region;
// Original Apache-2.0 native surface. All UI comes from the published gpui crate.
mod activity;
mod app_parent;
mod brain;
mod browser_panel;
#[path = "shell_features/connection/client.rs"]
mod client;
mod clock;
mod composer;
mod devices_panel;
mod diff;
#[cfg(test)]
mod diff_tests;
mod diff_ui;
mod files_panel;
mod grid_sessions;
mod icon;
mod inbox;
#[cfg(test)]
mod input_reuse_tests;
mod issues;
mod merge;
mod model;
mod motion;
mod pane;
mod pane_tree;
mod pane_grid;
mod pane_layout;
mod project_icon;
mod projects;
mod projects_model;
mod retained;
mod rich;
mod settings;
mod settings_fields;
mod settings_secret;
mod shell;
mod shell_state;
mod sidebar;
mod stream;
mod terminal;
mod terminal_grid;
mod terminal_transport;
mod text;
mod theme;
#[cfg(test)]
mod theme_tests;
mod trace;
mod transport;
mod ui;
mod visualizations;
mod wake;
use crate::{
    client::Client,
    model::{History, render_tree},
};
use serde_json::json;
use std::{env, fs, process::ExitCode, time::Instant};

fn run() -> Result<(), String> {
    let started = Instant::now();
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args == ["--help"] {
        println!(
            "o8-next --enable-next --server http://127.0.0.1:PORT [--offscreen] [--terminal SESSION_ID | --benchmark FILE | --composer-benchmark FILE]\nSaved sessions, composer and opt-in terminal. Set O8_NEXT_API_TOKEN for the selected server. No data-directory discovery.\no8-next --render-tree HISTORY.json\no8-next --sidebar-tree SESSIONS.json SELECTED_ID"
        );
        println!("{}", shell::HELP);
        println!(
            "Pane grid: --pane-grid 1|2|4|6 --workspace REPOSITORY_PATH --pane-layout ABSOLUTE_FILE"
        );
        println!("{}", diff_ui::HELP);
        return Ok(());
    }
    if diff_ui::try_launch(&args)? {
        return Ok(());
    }
    if args.first().is_some_and(|s| s == "--replay-tree") && args.len() == 2 {
        let replay: stream::Replay =
            serde_json::from_slice(&fs::read(&args[1]).map_err(|_| "Cannot read replay")?)
                .map_err(|_| "Invalid replay")?;
        let mut transcript = stream::Transcript::new(replay.initial);
        for message in replay.frames {
            transcript.apply(&message);
        }
        println!("{}", serde_json::to_string(&transcript.rows).unwrap());
        return Ok(());
    }
    if args.first().is_some_and(|s| s == "--render-tree") && args.len() == 2 {
        let history: History =
            serde_json::from_slice(&fs::read(&args[1]).map_err(|_| "Cannot read recording")?)
                .map_err(|_| "Invalid recording")?;
        println!(
            "{}",
            serde_json::to_string(&render_tree(&history.transcript)).unwrap()
        );
        return Ok(());
    }
    if args.first().is_some_and(|s| s == "--sidebar-tree") && args.len() == 3 {
        let sessions: Vec<client::Session> =
            serde_json::from_slice(&fs::read(&args[1]).map_err(|_| "Cannot read sidebar fixture")?)
                .map_err(|_| "Invalid sidebar fixture")?;
        println!(
            "{}",
            serde_json::to_string(&sidebar::tree(&sessions, Some(&args[2]))).unwrap()
        );
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--app-shell") {
        app_parent::watch();
    }
    if shell::try_launch(&args)? {
        return Ok(());
    }
    let grid = pane_layout::Options::extract(&mut args)?;
    let mut server = None;
    let mut terminal = None;
    let mut offscreen = false;
    let mut enabled = false;
    let mut benchmark = None;
    let mut composer_benchmark = None;
    let mut unattended = false;
    let mut stream_output = None;
    let mut stream_through = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--enable-next" => enabled = true,
            "--offscreen" => offscreen = true,
            "--unattended-on-screen" => unattended = true,
            "--server"
            | "--terminal"
            | "--benchmark"
            | "--composer-benchmark"
            | "--stream-benchmark"
            | "--stream-through" => {
                i += 1;
                let value = args.get(i).ok_or("Missing flag value")?.clone();
                if args[i - 1] == "--server" {
                    server = Some(value);
                } else if args[i - 1] == "--terminal" {
                    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control)
                    {
                        return Err("Invalid terminal session id".into());
                    }
                    terminal = Some(value);
                } else if args[i - 1] == "--benchmark" {
                    benchmark = Some(value);
                } else if args[i - 1] == "--composer-benchmark" {
                    composer_benchmark = Some(value);
                } else if args[i - 1] == "--stream-benchmark" {
                    stream_output = Some(value);
                } else {
                    stream_through = Some(
                        value
                            .parse::<u64>()
                            .map_err(|_| "Invalid stream sequence")?,
                    );
                }
            }
            _ => return Err("Unknown argument; use --help".into()),
        }
        i += 1;
    }
    if !enabled {
        return Err("This surface is opt-in; pass --enable-next".into());
    }
    if (benchmark.is_some() || composer_benchmark.is_some() || stream_output.is_some())
        && !offscreen
    {
        return Err("Automated benchmarks require --offscreen".into());
    }
    if composer_benchmark.is_some()
        && (benchmark.is_some() || stream_output.is_some() || unattended)
    {
        return Err("Use --composer-benchmark alone with --offscreen".into());
    }
    let stream_benchmark = match (stream_output, stream_through) {
        (Some(path), Some(seq)) if seq > 0 && benchmark.is_none() => Some((path, seq)),
        (None, None) => None,
        _ => {
            return Err(
                "Use --stream-benchmark FILE with --stream-through SEQ, without --benchmark".into(),
            );
        }
    };
    if let Some(options) = grid {
        if terminal.is_some() {
            return Err(
                "Use per-slot terminal selection in the pane grid, without --terminal".into(),
            );
        }
        if benchmark.is_some()
            || composer_benchmark.is_some()
            || stream_benchmark.is_some()
            || unattended
        {
            return Err(
                "Pane grid uses its own headless test workload; omit single-pane benchmark flags"
                    .into(),
            );
        }
        let grid_client = Client::new(
            server
                .as_deref()
                .ok_or("Pass --server with an explicit disposable server origin")?,
        )?;
        return pane_grid::launch(grid_client, offscreen, options);
    }
    let client =
        Client::new(&server.ok_or("Pass --server with an explicit disposable server origin")?)?;
    if let Some(session) = terminal {
        if benchmark.is_some()
            || composer_benchmark.is_some()
            || stream_benchmark.is_some()
            || unattended
        {
            return Err("Use --terminal alone with --server and optional --offscreen".into());
        }
        terminal::launch(client, session, offscreen);
        return Ok(());
    }
    // The real session list and history reads are also exercised without a window
    // by the parity/protocol runner. Interactive reads happen off the UI thread.
    ui::launch(
        client,
        offscreen,
        unattended,
        benchmark,
        composer_benchmark,
        stream_benchmark,
        started,
    );
    Ok(())
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", json!({"error": error}));
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recorded_web_parity() {
        for case in ["review", "tools", "long", "rich"] {
            let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
            let history: History = serde_json::from_slice(
                &fs::read(base.join(format!("{case}.history.json"))).unwrap(),
            )
            .unwrap();
            let expected: serde_json::Value =
                serde_json::from_slice(&fs::read(base.join(format!("{case}.tree.json"))).unwrap())
                    .unwrap();
            assert_eq!(
                serde_json::to_value(render_tree(&history.transcript)).unwrap(),
                expected,
                "{case}"
            );
        }
    }
}
