#![cfg(unix)]
use std::{fs, net::{TcpListener, TcpStream}, os::unix::fs::PermissionsExt, path::PathBuf, process::{Child, Command, Stdio}, time::{Duration, Instant}};
struct Fixture { root: PathBuf, launcher: Option<Child> }
fn until(mut f: impl FnMut() -> bool) { let deadline = Instant::now() + Duration::from_secs(12); while !f() { assert!(Instant::now() < deadline, "fixture deadline"); std::thread::sleep(Duration::from_millis(25)); } }
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from("/tmp").join(format!("o8-launch-fixture-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let script = r#"#!/usr/bin/env python3
import os,sys,time,json,subprocess,signal
from http.server import HTTPServer,BaseHTTPRequestHandler
from pathlib import Path
root=Path(__file__).parent
if '--version' in sys.argv: print('v22.0.0'); sys.exit(0)
if '-e' in sys.argv: sys.exit(0)
if Path(sys.argv[0]).name=='dialog': (root/'dialog-reached').write_text(sys.argv[1]); sys.exit(0)
if Path(sys.argv[0]).name=='window':
 (root/'window-ready').write_text(str(os.getpid()))
 while True: time.sleep(1)
api=sys.argv[1].endswith('server.js')
(root/('api-starts' if api else 'ws-starts')).open('a').write(str(os.getpid())+'\n')
if not api:
 import socket
 s=socket.socket(); s.bind(('127.0.0.1',int(os.environ['WS_PORT']))); s.listen()
 while True: time.sleep(1)
(root/'ws-token').write_text('fixture-token')
os.chmod(root/'ws-token',0o600)
window=None
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  time.sleep(float((root/'health-delay').read_text()) if (root/'health-delay').exists() else 0)
  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'bootId':os.environ['O8_BOOT_ID']}).encode())
 def do_POST(self):
  global window
  assert self.headers.get('Authorization')=='Bearer fixture-token'
  if (root/'fail-window').exists():
   self.send_response(500); self.end_headers(); self.wfile.write(b'{"code":"NEXT_STARTUP_FAILED"}'); return
  if window is None:
   window=subprocess.Popen([os.environ['O8_NEXT_BIN'],'--enable-next','--app-shell','--server','http://127.0.0.1:'+os.environ['PORT'],'--shell-state',str(root/'next-shell.json')])
  (root/'shows').open('a').write('show\n')
  self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
HTTPServer(('127.0.0.1',int(os.environ['PORT'])),Handler).serve_forever()
"#;
        for name in ["node", "dialog", "window"] { let p = root.join(name); fs::write(&p, script).unwrap(); fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap(); }
        for name in ["server.js", "ws-server.mjs"] { fs::write(root.join(name), "fixture").unwrap(); }
        let config = serde_json::json!({"data_dir":root,"server_dir":root,"node":root.join("node"),"window":root.join("window"),"api_port":0,"ws_port":0,"version":"fixture","dialog":root.join("dialog")});
        fs::write(root.join("config.json"), config.to_string()).unwrap();
        Self { root, launcher: None }
    }
    fn launch(&self) -> Child { Command::new(env!("CARGO_BIN_EXE_o8-launcher")).arg("--config").arg(self.root.join("config.json")).env("HOME", &self.root).stdout(Stdio::null()).stderr(fs::File::create(self.root.join("launcher-stderr")).unwrap()).spawn().unwrap() }
    fn start(&mut self) { self.launcher = Some(self.launch()); }
    fn ready(&self) { until(|| self.root.join("window-ready").exists()); }
    fn port(&self, name: &str) -> u16 { fs::read_to_string(self.root.join(name)).unwrap().parse().unwrap() }
    fn stop(&mut self) { let child = self.launcher.as_mut().unwrap(); unsafe { libc::kill(child.id() as i32, libc::SIGTERM); } until(|| child.try_wait().unwrap().is_some()); self.launcher = None; }
    fn starts(&self, name: &str) -> Vec<u32> { fs::read_to_string(self.root.join(name)).unwrap_or_default().lines().map(|s| s.parse().unwrap()).collect() }
}
impl Drop for Fixture { fn drop(&mut self) { if self.launcher.is_some() { self.stop(); } if std::thread::panicking() { eprintln!("startup: {:?}; stderr: {:?}", fs::read_to_string(self.root.join("logs/gpui-startup.log")), fs::read_to_string(self.root.join("launcher-stderr"))); } let _ = fs::remove_dir_all(&self.root); } }
#[test]
fn cold_start_waits_for_health_and_shutdown_frees_both_ports() {
    let mut f = Fixture::new(); fs::write(f.root.join("health-delay"), "0.25").unwrap(); f.start();
    until(|| f.root.join("api-starts").exists()); assert!(!f.root.join("window-ready").exists());
    f.ready(); let api = f.port("api-port"); let ws = f.port("ws-port");
    let window: i32 = fs::read_to_string(f.root.join("window-ready")).unwrap().parse().unwrap();
    f.stop();
    assert!(TcpListener::bind(("127.0.0.1", api)).is_ok()); assert!(TcpListener::bind(("127.0.0.1", ws)).is_ok());
    assert!(!f.root.join("launcher-api.json").exists()); assert_eq!(unsafe { libc::kill(window, 0) }, -1);
}
#[test]
fn second_instance_reuses_servers_and_requests_show() {
    let mut f = Fixture::new(); f.start(); f.ready(); let before = fs::read_to_string(f.root.join("shows")).unwrap().lines().count();
    assert!(f.launch().wait().unwrap().success()); until(|| fs::read_to_string(f.root.join("shows")).unwrap().lines().count() > before);
    assert_eq!(f.starts("api-starts").len(), 1); assert_eq!(f.starts("ws-starts").len(), 1);
}
#[test]
fn child_crash_restarts_and_shutdown_during_delay_does_not_respawn() {
    let mut f = Fixture::new(); f.start(); f.ready(); let old = f.starts("ws-starts")[0];
    unsafe { libc::kill(old as i32, libc::SIGKILL); }
    until(|| f.starts("ws-starts").len() == 2); let latest = f.starts("ws-starts")[1];
    unsafe { libc::kill(latest as i32, libc::SIGKILL); }
    f.stop(); assert_eq!(f.starts("ws-starts").len(), 2);
}
#[test]
fn start_failure_reaches_injected_dialog_and_cleans_children() {
    let mut f = Fixture::new(); fs::write(f.root.join("fail-window"), "1").unwrap(); f.start();
    until(|| f.root.join("dialog-reached").exists());
    let child = f.launcher.as_mut().unwrap(); until(|| child.try_wait().unwrap().is_some()); assert!(!child.wait().unwrap().success()); f.launcher = None;
    let message = fs::read_to_string(f.root.join("dialog-reached")).unwrap(); assert!(message.contains("GPUI")); assert!(!message.contains("fixture-token"));
    assert!(TcpListener::bind(("127.0.0.1", f.port("api-port"))).is_ok());
}
#[test]
fn crashed_parent_orphans_are_cleaned_without_touching_foreign_listener() {
    let foreign = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut f = Fixture::new(); f.start(); f.ready(); let port = f.port("api-port");
    let child = f.launcher.as_mut().unwrap(); child.kill().unwrap(); child.wait().unwrap(); f.launcher = None;
    fs::remove_file(f.root.join("window-ready")).unwrap(); f.start(); f.ready();
    assert!(TcpListener::bind(("127.0.0.1", port)).is_ok()); assert!(TcpStream::connect(foreign.local_addr().unwrap()).is_ok());
}
