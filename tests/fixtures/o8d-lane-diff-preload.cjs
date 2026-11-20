// Owned fixture counters/faults only. Real auth, lane resolution and git remain intact.
const Module=require('node:module'),fs=require('node:fs'),path=require('node:path');
const {AsyncLocalStorage}=require('node:async_hooks'); const scope=new AsyncLocalStorage();
const directory=process.env.CORTEX_IDE_DATA_DIR;
if(process.env.NODE_ENV!=='test'||fs.readFileSync(path.join(directory,'fixture-owner'),'utf8')!=='o8d-native-read/v1')throw Error('Owned lane fixture required');
Module.register(require('node:url').pathToFileURL(path.join(__dirname,'o8d-lane-diff-loader.mjs')).href);
const settings=()=>{try{return JSON.parse(fs.readFileSync(path.join(directory,'lane-diff-control.json'),'utf8'));}catch{return{};}};
const count=name=>{const ctx=scope.getStore();if(ctx?.active)fs.appendFileSync(path.join(directory,'lane-diff-counters.jsonl'),JSON.stringify({nonce:settings().nonce,phase:ctx.phase,name})+'\n');};
const original=Module._load,cache=new WeakMap();
Module._load=function(request,parent,isMain){const actual=original.call(this,request,parent,isMain);let file;try{file=Module._resolveFilename(request,parent);}catch{return actual;}if(!actual||typeof actual!=='object')return actual;if(cache.has(actual))return cache.get(actual);
  if(file.endsWith('/lane/review-source.ts')){const result={...actual,readLaneReviewDiff(...args){count('readLaneReviewDiff');return actual.readLaneReviewDiff(...args);}};cache.set(actual,result);return result;}
  if(file.endsWith('/ws-server/native-http-routes.ts')){const result={...actual,handleNativeHttp(req,...args){if(!/^\/api\/lanes\/[^/]+\/diff(?:\?|$)/.test(req.url??''))return actual.handleNativeHttp(req,...args);
    const admission=req.headers['x-o8d-session-read']==='authorize'&&args[2]===true;
    const ctx={phase:admission?'admission':'typescript',active:true};
    if(admission){const res=args[0],write=res.write.bind(res),end=res.end.bind(res);const chunks=[];
      res.write=function(chunk){chunks.push(Buffer.from(chunk));return true;};res.end=function(){let body=Buffer.concat(chunks);if(res.statusCode===200){const grant=JSON.parse(body);if(grant.defaultsContext?.laneDiffTarget)count('materializedGrant');const control=settings();
        if(control.missingGrant)body=Buffer.alloc(0);
        else{if(control.malformedGrant)grant.redaction.normalizedValues=12;if(control.overLimitGrant)grant.redaction.normalizedValues=Array(1025).fill('fixture');if(control.wrongTarget)grant.defaultsContext.laneDiffTarget.requestId='different-request';if(control.relativeRoot)grant.defaultsContext.laneDiffTarget.cwd='../outside';body=Buffer.from(JSON.stringify(grant));}}
        write(body);return end();};}
    return scope.run(ctx,async()=>{try{return await actual.handleNativeHttp(req,...args);}finally{ctx.active=false;}});
  }};cache.set(actual,result);return result;}return actual;};
