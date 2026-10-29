use super::*;
struct DeviceTests;
register_shell_feature!(DeviceTests);
impl ShellFeature for DeviceTests {}
#[path = "../devices_panel/tests.rs"]
mod tests;
