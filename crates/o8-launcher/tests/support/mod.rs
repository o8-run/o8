#![cfg(unix)]
use std::{
    fs,
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
pub struct Fixture {
    pub root: PathBuf,
    pub launcher: Option<Child>,
}
pub fn until(mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while !f() {
        assert!(Instant::now() < deadline, "fixture deadline");
        std::thread::sleep(Duration::from_millis(25));
    }
}
impl Fixture {
    pub fn new() -> Self {
        let root =
            PathBuf::from("/tmp").join(format!("o8-launch-fixture-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let script = r#"#!/usr/bin/env python3
import os,sys,time,json,subprocess,signal
from http.server import HTTPServer,BaseHTTPRequestHandler
from pathlib import Path
root=Path(__file__).parent
if '--version' in sys.argv:
 if (root/'receipt-trap').exists():
  if (root/'hardlink-trap').exists(): os.link(root/'trap-target',root/'launcher-api.json')
  else: (root/'launcher-api.json').symlink_to(root/'trap-target')
 print('v22.0.0'); sys.exit(0)
if '-e' in sys.argv: sys.exit(0)
if Path(sys.argv[0]).name=='dialog': (root/'dialog-reached').write_text(sys.argv[1]); sys.exit(0)
if Path(sys.argv[0]).name=='probe':
 if (root/'hold-probe').exists():
  (root/'probe-entered').write_text('1')
  while (root/'hold-probe').exists(): time.sleep(0.02)
 print('__O8_PATH='+os.environ['PATH']); print('__O8_NODE='+str(root/'node')); print('GEMINI_API_KEY=fixture-key'); sys.exit(0)
if Path(sys.argv[0]).name=='focus':
 (root/'focus-shows').open('a').write(sys.argv[1]+'\n'); sys.exit(0)
if Path(sys.argv[0]).name=='window':
 (root/'window-args').write_text(json.dumps(sys.argv[1:]))
 (root/'window-ready').write_text(str(os.getpid()))
 sys.stdin.buffer.read(); sys.exit(0)
api=sys.argv[1].endswith('server.js')
keys=['O8_DATA_DIR','CORTEX_IDE_DATA_DIR','O8_NODE_BIN','O8_PACKAGED_APP','O8_BOOT_ID','O8_INSTANCE_ID','O8_SIDECAR_PID','NODE_COMPILE_CACHE','O8_PI_WRITE_BIN','O8_BUNDLED_MCP_DIR','O8_BUNDLED_MCP_PATH','O8_NEXT_MAIN_WINDOW','PORT','HOSTNAME','NODE_ENV','O8_API_PORT','O8_WS_PORT','CORTEX_IDE_API_PORT','CORTEX_IDE_WS_PORT','WS_PORT','O8_NEXT_BIN','O8_CODEBASE_MEMORY_BIN','O8_APP_VERSION','NEXT_ORIGIN','GEMINI_API_KEY','PATH']
(root/('api-env' if api else 'ws-env')).write_text(json.dumps({k:os.environ.get(k) for k in keys}))
def terminated(*args):
 (root/'events').open('a').write(('api' if api else 'ws')+'-stop\n'); sys.exit(0)
signal.signal(signal.SIGTERM,terminated)
(root/('api-starts' if api else 'ws-starts')).open('a').write(str(os.getpid())+'\n')
if not api:
 import socket
 s=socket.socket(); s.bind(('127.0.0.1',int(os.environ['WS_PORT']))); s.listen()
 if (root/'graceful-child').exists():
  reader,writer=os.pipe()
  if os.fork()==0:
   os.close(writer)
   def interrupted(*args): (root/'drain-interrupted').write_text('1'); os._exit(1)
   signal.signal(signal.SIGTERM,interrupted)
   os.read(reader,1); time.sleep(0.4); (root/'child-drained').write_text('1'); os._exit(0)
  os.close(reader)
 if (root/'crash-ws').exists():
  import threading
  threading.Timer(0.05,lambda:os._exit(17)).start()
 if (root/'stubborn-child').exists() and os.fork()==0:
  signal.signal(signal.SIGTERM,signal.SIG_IGN); (root/'held-pid').write_text(str(os.getpid()))
  while True: time.sleep(1)
 while True: time.sleep(1)
(root/'ws-token').write_text('fixture-token')
os.chmod(root/'ws-token',0o600)
window=None
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  time.sleep(float((root/'health-delay').read_text()) if (root/'health-delay').exists() else 0)
  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'bootId':'foreign-boot' if (root/'wrong-boot').exists() else os.environ['O8_BOOT_ID']}).encode())
 def do_POST(self):
  global window
  assert self.headers.get('Authorization')=='Bearer fixture-token'
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path.endswith('/update-state'):
   assert body['autoApply']['action']=='inspect-restart'
   (root/'events').open('a').write('inspect\n')
   self.send_response(200); self.end_headers(); self.wfile.write(b'{"allowed":true}'); return
  if self.path.endswith('/cloud-jobs/drain'):
   assert body=={'finalize':True}
   (root/'events').open('a').write('drain\n'); self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}'); return
  assert body=={'experimentalNext':True}
  if (root/'fail-window').exists():
   self.send_response(500); self.end_headers(); self.wfile.write(b'{"code":"NEXT_STARTUP_FAILED"}'); return
  if window is None:
   window=subprocess.Popen([os.environ['O8_NEXT_BIN'],'--enable-next','--app-shell','--server','http://127.0.0.1:'+os.environ['PORT'],'--shell-state',str(root/'next-shell.json')],stdin=subprocess.PIPE)
  (root/'shows').open('a').write('show\n')
  self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
HTTPServer(('127.0.0.1',int(os.environ['PORT'])),Handler).serve_forever()
"#;
        for name in ["node", "dialog", "window", "probe", "focus"] {
            let p = root.join(name);
            fs::write(&p, script).unwrap();
            fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap();
        }
        for name in ["server.js", "ws-server.mjs"] {
            fs::write(root.join(name), "fixture").unwrap();
        }
        let config = serde_json::json!({"data_dir":root,"server_dir":root,"node":root.join("node"),"window":root.join("window"),"api_port":0,"ws_port":0,"version":"fixture","dialog":root.join("dialog"),"probe":root.join("probe"),"focus":root.join("focus"),"native_lifecycle":false});
        fs::write(root.join("config.json"), config.to_string()).unwrap();
        Self {
            root,
            launcher: None,
        }
    }
    pub fn launch(&self) -> Child {
        let mut command = Command::new(env!("CARGO_BIN_EXE_o8-launcher"));
        command.env_clear();
        if self.root.join("memory-helper").exists() {
            command.env("O8_CODEBASE_MEMORY_BIN", self.root.join("memory-helper"));
        }
        if self.root.join("voice-only").exists() {
            command.env("O8_VOICE_ONLY", "1");
        }
        command
            .arg("--config")
            .arg(self.root.join("config.json"))
            .env(
                "PATH",
                if self.root.join("minimal-path").exists() {
                    std::ffi::OsString::from("/usr/local/bin:/usr/bin:/bin")
                } else {
                    std::env::var_os("PATH").unwrap()
                },
            )
            .env("HOME", &self.root)
            .env("LANG", "C")
            .stdout(Stdio::null())
            .stderr(fs::File::create(self.root.join("launcher-stderr")).unwrap())
            .spawn()
            .unwrap()
    }
    pub fn start(&mut self) {
        self.launcher = Some(self.launch());
    }
    pub fn ready(&self) {
        until(|| {
            self.root.join("window-ready").exists()
                && self.root.join("ws-env").exists()
                && TcpStream::connect(("127.0.0.1", self.port("ws-port"))).is_ok()
        });
    }
    pub fn port(&self, name: &str) -> u16 {
        fs::read_to_string(self.root.join(name))
            .unwrap()
            .parse()
            .unwrap()
    }
    pub fn stop(&mut self) {
        let child = self.launcher.as_mut().unwrap();
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        until(|| child.try_wait().unwrap().is_some());
        self.launcher = None;
    }
    pub fn starts(&self, name: &str) -> Vec<u32> {
        fs::read_to_string(self.root.join(name))
            .unwrap_or_default()
            .lines()
            .map(|s| s.parse().unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.root.join("hold-probe"));
        if self.launcher.is_some() {
            self.stop();
        }
        if std::thread::panicking() {
            eprintln!(
                "startup: {:?}; stderr: {:?}",
                fs::read_to_string(self.root.join("logs/gpui-startup.log")),
                fs::read_to_string(self.root.join("launcher-stderr"))
            );
        }
        for name in ["api-starts", "ws-starts"] {
            for pid in self.starts(name) {
                let output = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "command="])
                    .output()
                    .unwrap();
                if String::from_utf8_lossy(&output.stdout)
                    .contains(&self.root.to_string_lossy().to_string())
                    && unsafe { libc::getpgid(pid as i32) } == pid as i32
                {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn control(f: &Fixture, request: serde_json::Value) -> serde_json::Value {
    use std::io::{Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(f.root.join("launcher.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(request.to_string().as_bytes()).unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
