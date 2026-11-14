//! Launch mechanics shared by the classic shell and the standalone launcher.
pub mod no_window;
pub mod shell_env;
#[cfg(any(windows, test))]
pub mod windows_node_locate;
pub mod preflight;
pub mod ports;
pub mod restart;
pub mod next_main_startup;
pub mod restart_job_drain;
pub mod cli_locate;
pub mod path_env;
pub mod server_env;
pub mod identity;
