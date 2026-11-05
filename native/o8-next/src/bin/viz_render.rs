//! One-shot Linux snapshot renderer. The application never links this module tree.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "../visualizations/linux_protocol.rs"]
mod linux_protocol;
#[cfg(target_os = "linux")]
#[path = "viz_render/linux_renderer.rs"]
mod linux_renderer;
#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[path = "../visualizations/protocol.rs"]
mod protocol;

#[cfg(target_os = "linux")]
use {
    linux_protocol::{MAX_INPUT, Request, TIMEOUT},
    protocol::UNAVAILABLE,
    std::{io::Read, thread},
};

#[cfg(target_os = "linux")]
/// Standalone helper entry point. Stdin/stdout only.
pub fn entry() -> Result<(), String> {
    // A hard watchdog also bounds standalone invocations and blocked stdin.
    thread::spawn(|| {
        thread::sleep(TIMEOUT);
        std::process::exit(1);
    });
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut input)
        .map_err(|_| UNAVAILABLE)?;
    if input.len() as u64 > MAX_INPUT {
        return Err(UNAVAILABLE.into());
    }
    let request: Request = serde_json::from_slice(&input).map_err(|_| UNAVAILABLE)?;
    if !request.valid() {
        return Err(UNAVAILABLE.into());
    }
    let response = linux_renderer::snapshot(request)?;
    serde_json::to_writer(std::io::stdout().lock(), &response).map_err(|_| UNAVAILABLE.into())
}

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    match entry() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", serde_json::json!({"error": error}));
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    std::process::ExitCode::FAILURE
}
