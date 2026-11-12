(function(){
  var root=document.getElementById('working'); if(!root) return;
  var D=JSON.parse(document.getElementById('wk-data').textContent);
  var miniEl=root.querySelector('.wk-mini'), bigEl=root.querySelector('.wk-big'),
      lineEl=root.querySelector('.wk-line'), timeEl=root.querySelector('.wk-time'),
      play=root.querySelector('.wk-play'), btns=[].slice.call(root.querySelectorAll('.wk-ctl button[data-i]'));
  var n=0, cur=-1, pending=null, demo=true, paused=false, svgs=[], lastLoop=0, left=0;
  try{ paused=window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch{}
  // New motion goes in a layer on top; the old layer fades out over 0.3s, which covers the edge change
  // between fog and hard-edged motions and the two loops that don't rest on full Glance.
  function mount(el, txt){
    n++; var layer=document.createElement('div'); layer.className='wk-layer';
    layer.innerHTML=txt.replace(/\b(gb|hs)(\d+)/g,'$1$2w'+n+'_');
    var old=[].slice.call(el.children); el.appendChild(layer);
    old.forEach(function(o){ o.classList.add('gone'); setTimeout(function(){ if(o.parentNode) o.parentNode.removeChild(o); },350); });
    return layer.querySelector('svg');
  }
  function setText(t){
    if(lineEl.textContent===t) return;
    lineEl.classList.add('out');
    setTimeout(function(){ lineEl.textContent=t; lineEl.classList.remove('out'); },180);
  }
  function show(i){
    cur=i; var s=D.mini[i];
    svgs=[mount(miniEl,s.svg), mount(bigEl,D.big[i])];
    svgs.forEach(function(v){ try{ v.setCurrentTime(0); if(paused) v.pauseAnimations(); }catch{} });
    lastLoop=0; left=s.loops; setText(s.line);
    btns.forEach(function(b,j){ b.setAttribute('aria-pressed', j===i?'true':'false'); b.classList.remove('queued'); });
  }
  function landed(){
    if(pending!==null){ var p=pending; pending=null; if(p!==cur){ show(p); return; } }
    if(demo){ left--; if(left<=0) show((cur+1)%D.mini.length); }
  }
  function fmt(t){ t=Math.floor(t); return Math.floor(t/60)+':'+('0'+(t%60)).slice(-2); }
  function tick(){
    if(svgs[0] && !paused){
      var t=0; try{ t=svgs[0].getCurrentTime(); }catch{}
      var L=Math.floor(t/D.mini[cur].dur);
      if(L>lastLoop){ lastLoop=L; landed(); }
      timeEl.textContent=fmt(t)+' · esc to stop';
    }
    requestAnimationFrame(tick);
  }
  function setPaused(p){
    paused=p; svgs.forEach(function(v){ try{ if(p) v.pauseAnimations(); else v.unpauseAnimations(); }catch{} });
  }
  play.addEventListener('click',function(){
    if(demo && !paused){ demo=false; setPaused(true); }
    else { demo=true; setPaused(false); }
    play.setAttribute('aria-pressed', demo&&!paused?'true':'false');
    play.textContent=demo&&!paused?'Pause demo':'Play demo';
  });
  btns.forEach(function(b){ b.addEventListener('click',function(){
    var i=+b.getAttribute('data-i'); demo=false;
    play.setAttribute('aria-pressed','false'); play.textContent='Play demo';
    if(paused || cur<0){ show(i); return; }
    pending=i; btns.forEach(function(x){ x.classList.remove('queued'); }); if(i!==cur) b.classList.add('queued');
  }); });
  if(paused){ demo=false; play.setAttribute('aria-pressed','false'); play.textContent='Play demo'; }
  show(0); requestAnimationFrame(tick);
})();
