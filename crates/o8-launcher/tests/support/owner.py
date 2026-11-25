#!/usr/bin/env python3
# Minimal daemon peer for the launcher's process-ownership fixtures. The real
# daemon/Node/window transport is covered by launcher-o8d-owner-real-path.test.ts.
import http.client,json,os,signal,socket,sys,threading
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
args=sys.argv[1:]
open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'o8d-env'),'w').write(json.dumps({'MallocSpaceEfficient':os.environ.get('MallocSpaceEfficient')}))
path=args[args.index('--producer-socket')+1]
port=int(args[args.index('--listen')+1].rsplit(':',1)[1])
upstream=None
def stop(*args):
 try: os.unlink(path)
 except FileNotFoundError: pass
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
sock=socket.socket(socket.AF_UNIX);sock.bind(path);os.chmod(path,0o600);sock.listen()
def accept():
 global upstream
 while True:
  peer,_=sock.accept()
  try:
   file=peer.makefile('rb');grant=json.loads(file.readline(16384))
   assert grant['key']==os.environ['O8D_BRIDGE_KEY'] and grant['version']==1
   upstream=grant['upstream']
   peer.sendall((json.dumps({'version':1,'pid':os.getpid(),'generation':1,'epoch':grant['epoch']})+'\n').encode())
   file.read();upstream=None
  except Exception: peer.close()
threading.Thread(target=accept,daemon=True).start()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def relay(self):
  if upstream is None: self.send_response(503);self.end_headers();return
  conn=http.client.HTTPConnection(upstream,timeout=2)
  body=self.rfile.read(int(self.headers.get('Content-Length',0)))
  conn.request(self.command,self.path,body,dict(self.headers))
  response=conn.getresponse();data=response.read()
  self.send_response(response.status);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);conn.close()
 do_GET=relay
 do_POST=relay
ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
