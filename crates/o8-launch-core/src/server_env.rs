//! Explicit environment used by both shell and standalone launch owners.
use crate::{no_window::NoWindow, ports};
use std::{path::PathBuf, process::Command};
pub fn voice_only(value: Option<&str>) -> bool {
    value.is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

/// The allocator setting the Node servers start with on macOS.
pub const MALLOC_SPACE_EFFICIENT: &str = "MallocSpaceEfficient";

#[derive(Default)]
pub struct ServerEnvironment {
    pub data_dir: String,
    pub node_bin: String,
    pub server_dir: PathBuf,
    pub api_port: u16,
    pub ws_port: u16,
    pub boot_id: String,
    pub instance_id: String,
    pub compile_cache: String,
    pub pi_write: Option<PathBuf>,
    pub mcp: Option<PathBuf>,
    pub window: Option<PathBuf>,
    pub codebase_memory: Option<String>,
    pub ai_keys: Vec<(String, String)>,
    pub native_main: bool,
    pub voice_only: bool,
    pub version: String,
    pub next_origin: String,
    /// Behind the API front door (`O8_API_FRONT_DOOR`), WS answers the public
    /// API port and Next listens on this private loopback port.
    pub private_next_port: Option<u16>,
    /// Next is not started, so WS runs Next's startup work (`O8_NEXT_OFF`).
    pub next_off: bool,
}
impl ServerEnvironment {
    fn common(&self, command: &mut Command) {
        command
            .no_window()
            .env("O8_DATA_DIR", &self.data_dir)
            .env("CORTEX_IDE_DATA_DIR", &self.data_dir)
            .env("O8_NODE_BIN", &self.node_bin)
            .env("O8_PACKAGED_APP", "1")
            .env("O8_BOOT_ID", &self.boot_id)
            .env("O8_INSTANCE_ID", &self.instance_id)
            .env("O8_SIDECAR_PID", std::process::id().to_string())
            .env("NODE_COMPILE_CACHE", &self.compile_cache);
        // macOS keeps pages a server freed after startup counted against it
        // until memory runs short. This mode hands them back (about 40 MB less
        // footprint for the WS server at rest). Each server removes it from its
        // own environment at startup, so the agents and tools it starts keep
        // the default allocator.
        #[cfg(target_os = "macos")]
        command.env(MALLOC_SPACE_EFFICIENT, "1");
        if let Some(path) = &self.pi_write {
            command.env("O8_PI_WRITE_BIN", path);
        }
        if let Some(path) = &self.mcp {
            command
                .env("O8_BUNDLED_MCP_DIR", &self.server_dir)
                .env("O8_BUNDLED_MCP_PATH", path);
        }
        if self.native_main {
            command.env("O8_NEXT_MAIN_WINDOW", "1");
        }
        if self.private_next_port.is_some() {
            command.env("O8_API_FRONT_DOOR", "1");
        }
        for (key, value) in &self.ai_keys {
            command.env(key, value);
        }
    }
    pub fn api(&self, command: &mut Command) {
        self.common(command);
        let (port, host) = match self.private_next_port {
            // Only the WS server reaches Next behind the front door.
            Some(port) => (port, "127.0.0.1"),
            None => (
                self.api_port,
                ports::listen_host_in(
                    std::env::var("O8_LAN_ACCESS").ok().as_deref(),
                    std::path::Path::new(&self.data_dir),
                ),
            ),
        };
        command
            .env("PORT", port.to_string())
            .env("HOSTNAME", host)
            .env("NODE_ENV", "production")
            .env("O8_API_PORT", self.api_port.to_string())
            .env("O8_WS_PORT", self.ws_port.to_string())
            .env("WS_PORT", self.ws_port.to_string());
        self.window_and_helpers(command);
    }
    /// The native window and helper paths for whichever server answers the
    /// public API port, which launches the window.
    fn window_and_helpers(&self, command: &mut Command) {
        if let Some(path) = &self.window {
            command.env("O8_NEXT_BIN", path);
        }
        if self.native_main && self.voice_only {
            command.env("O8_NEXT_BIN", "");
        }
        if let Some(path) = &self.codebase_memory {
            command.env("O8_CODEBASE_MEMORY_BIN", path);
        }
    }
    pub fn ws(&self, command: &mut Command) {
        self.common(command);
        command
            .env("WS_PORT", self.ws_port.to_string())
            .env("NEXT_ORIGIN", &self.next_origin)
            .env("O8_APP_VERSION", &self.version);
        if self.private_next_port.is_some() {
            self.window_and_helpers(command);
            if self.next_off {
                // WS is the only server, so it runs Next's startup work and
                // owns the native window (#5709 window-owner switch).
                command
                    .env("O8_NEXT_OFF", "1")
                    .env("O8_NEXT_WINDOW_OWNER", "ws");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[test]
    fn voice_flags_and_window_suppression_cover_all_modes() {
        for flag in [Some("1"), Some("true"), Some("TRUE")] {
            assert!(voice_only(flag));
        }
        for flag in [None, Some("0")] {
            assert!(!voice_only(flag));
        }
        for (native_main, voice_only) in
            [(false, true), (false, false), (true, false), (true, true)]
        {
            let env = ServerEnvironment {
                native_main,
                voice_only,
                window: Some("/fixture/window".into()),
                ..Default::default()
            };
            let mut command = Command::new("fixture");
            env.api(&mut command);
            let window = command
                .get_envs()
                .find(|(k, _)| *k == "O8_NEXT_BIN")
                .unwrap()
                .1
                .unwrap();
            assert_eq!(
                window,
                if native_main && voice_only {
                    ""
                } else {
                    "/fixture/window"
                }
            );
        }
    }
    #[test]
    fn optional_shell_resources_and_voice_suppression_match_both_child_commands() {
        let env = ServerEnvironment {
            data_dir: "/fixture/data".into(),
            node_bin: "/fixture/node".into(),
            server_dir: "/fixture/server".into(),
            api_port: 123,
            ws_port: 124,
            boot_id: "boot".into(),
            instance_id: "instance".into(),
            compile_cache: "/fixture/cache".into(),
            pi_write: Some("/fixture/pi".into()),
            mcp: Some("/fixture/mcp".into()),
            window: Some("/fixture/window".into()),
            codebase_memory: Some("/fixture/memory".into()),
            ai_keys: vec![("GEMINI_API_KEY".into(), "fixture-key".into())],
            native_main: true,
            voice_only: true,
            version: "fixture".into(),
            next_origin: "http://127.0.0.1:123".into(),
            private_next_port: None,
            next_off: false,
        };
        for api in [true, false] {
            let mut command = Command::new("fixture");
            if api {
                env.api(&mut command);
            } else {
                env.ws(&mut command);
            }
            let map: BTreeMap<_, _> = command
                .get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.unwrap().to_string_lossy().into_owned(),
                    )
                })
                .collect();
            for (key, value) in [
                ("O8_PI_WRITE_BIN", "/fixture/pi"),
                ("O8_BUNDLED_MCP_DIR", "/fixture/server"),
                ("O8_BUNDLED_MCP_PATH", "/fixture/mcp"),
                ("GEMINI_API_KEY", "fixture-key"),
                ("O8_NEXT_MAIN_WINDOW", "1"),
            ] {
                assert_eq!(map.get(key).map(String::as_str), Some(value));
            }
            assert_eq!(
                map.get(MALLOC_SPACE_EFFICIENT).map(String::as_str),
                cfg!(target_os = "macos").then_some("1")
            );
            if api {
                assert_eq!(map["O8_NEXT_BIN"], "");
                assert_eq!(map["O8_CODEBASE_MEMORY_BIN"], "/fixture/memory");
            } else {
                assert!(!map.contains_key("O8_NEXT_BIN"));
                assert!(!map.contains_key("O8_CODEBASE_MEMORY_BIN"));
            }
        }
    }
    #[test]
    fn front_door_moves_next_to_private_loopback_and_window_launch_to_ws() {
        let env = ServerEnvironment {
            data_dir: "/fixture/data".into(),
            api_port: 123,
            ws_port: 124,
            window: Some("/fixture/window".into()),
            codebase_memory: Some("/fixture/memory".into()),
            private_next_port: Some(125),
            ..Default::default()
        };
        let read = |api: bool| -> BTreeMap<String, String> {
            let mut command = Command::new("fixture");
            if api {
                env.api(&mut command);
            } else {
                env.ws(&mut command);
            }
            command
                .get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.unwrap().to_string_lossy().into_owned(),
                    )
                })
                .collect()
        };
        let (next, ws) = (read(true), read(false));
        assert_eq!(next["PORT"], "125");
        assert_eq!(next["HOSTNAME"], "127.0.0.1");
        assert_eq!(next["O8_API_PORT"], "123");
        for map in [&next, &ws] {
            assert_eq!(map["O8_API_FRONT_DOOR"], "1");
            assert_eq!(map["O8_NEXT_BIN"], "/fixture/window");
            assert_eq!(map["O8_CODEBASE_MEMORY_BIN"], "/fixture/memory");
            assert!(!map.contains_key("O8_NEXT_OFF"));
        }
        let off = ServerEnvironment {
            private_next_port: Some(125),
            next_off: true,
            ..Default::default()
        };
        let mut command = Command::new("fixture");
        off.ws(&mut command);
        for (key, value) in [("O8_NEXT_OFF", "1"), ("O8_NEXT_WINDOW_OWNER", "ws")] {
            assert!(command
                .get_envs()
                .any(|(k, v)| k == key && v == Some(value.as_ref())));
        }
    }
}
