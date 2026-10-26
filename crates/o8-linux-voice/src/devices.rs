//! Input-device listing for the mic picker (`--input-devices-json`), in the
//! Swift helper's shape: `{"type":"input_devices","devices":[{uid,name,is_default}]}`.
//! Uses `pactl`, which PipeWire (pipewire-pulse) and PulseAudio both serve.

use serde_json::{json, Value};
use std::ffi::OsStr;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputDevice {
    pub uid: String,
    pub name: String,
    pub is_default: bool,
}

/// Parse `pactl -f json list sources`, skipping monitor sources (those record
/// the speakers, not a microphone).
pub fn parse_pactl_sources_json(raw: &str, default: Option<&str>) -> Vec<InputDevice> {
    let Ok(Value::Array(sources)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    sources
        .iter()
        .filter_map(|s| {
            let uid = s.get("name")?.as_str()?.to_string();
            if uid.ends_with(".monitor")
                || s.get("monitor_of_sink")
                    .and_then(Value::as_str)
                    .is_some_and(|m| m != "n/a")
            {
                return None;
            }
            let name = s
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or(&uid)
                .to_string();
            let is_default = default == Some(uid.as_str());
            Some(InputDevice {
                uid,
                name,
                is_default,
            })
        })
        .collect()
}

fn pactl(search_path: &OsStr, args: &[&str]) -> Option<String> {
    let bin = crate::tools::find_in("pactl", search_path)?;
    let out = Command::new(bin).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn list_input_devices(search_path: &OsStr) -> Vec<InputDevice> {
    let default = pactl(search_path, &["get-default-source"]).map(|s| s.trim().to_string());
    pactl(search_path, &["-f", "json", "list", "sources"])
        .map(|raw| parse_pactl_sources_json(&raw, default.as_deref()))
        .unwrap_or_default()
}

pub fn input_devices_json(search_path: &OsStr) -> String {
    let devices: Vec<Value> = list_input_devices(search_path)
        .into_iter()
        .map(|d| json!({ "uid": d.uid, "name": d.name, "is_default": d.is_default }))
        .collect();
    json!({ "type": "input_devices", "devices": devices }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{fake_tool, TempDir};

    const SOURCES: &str = r#"[
      {"index":1,"name":"alsa_output.pci.analog-stereo.monitor","description":"Monitor of Built-in Audio","monitor_of_sink":"alsa_output.pci.analog-stereo"},
      {"index":2,"name":"alsa_input.pci.analog-stereo","description":"Built-in Audio Analog Stereo","monitor_of_sink":"n/a"},
      {"index":3,"name":"alsa_input.usb-Blue_Yeti","description":"Yeti Stereo Microphone"}
    ]"#;

    #[test]
    fn lists_microphones_and_marks_the_default() {
        let devices = parse_pactl_sources_json(SOURCES, Some("alsa_input.usb-Blue_Yeti"));
        assert_eq!(
            devices,
            vec![
                InputDevice {
                    uid: "alsa_input.pci.analog-stereo".into(),
                    name: "Built-in Audio Analog Stereo".into(),
                    is_default: false
                },
                InputDevice {
                    uid: "alsa_input.usb-Blue_Yeti".into(),
                    name: "Yeti Stereo Microphone".into(),
                    is_default: true
                },
            ]
        );
        assert!(parse_pactl_sources_json("garbage", None).is_empty());
    }

    #[test]
    fn emits_the_swift_helper_shape_and_degrades_without_pactl() {
        let empty = TempDir::new("devices-none");
        assert_eq!(
            input_devices_json(empty.path().as_os_str()),
            r#"{"devices":[],"type":"input_devices"}"#
        );

        let dir = TempDir::new("devices");
        let listing = SOURCES.replace('\n', " ");
        fake_tool(
            dir.path(),
            "pactl",
            &format!("if [ \"$1\" = get-default-source ]; then echo alsa_input.pci.analog-stereo; else echo '{listing}'; fi"),
        );
        let v: Value = serde_json::from_str(&input_devices_json(dir.path().as_os_str())).unwrap();
        assert_eq!(v["type"], "input_devices");
        assert_eq!(v["devices"][0]["uid"], "alsa_input.pci.analog-stereo");
        assert_eq!(v["devices"][0]["is_default"], true);
        assert_eq!(v["devices"].as_array().unwrap().len(), 2);
    }
}
