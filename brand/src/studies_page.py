import sys, base64; D=sys.argv[1]; sys.path.insert(0, D)
from glance import mark_vars, body_path
import morph, studies, logos, loopdial, fog

def m(size="full", state="reviewing", cls="mk"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="{cls}" aria-hidden="true">{mark_vars(size,state)}</svg>'
def g_lockup(cls="lockup-sm", size="full"):
    return f'<span class="lockup {cls}">{m(size)}<span class="wm">o8</span></span>'
def L(fn, cls="lg"): return logos.svg(fn(), cls)
def l_lockup(fn, cls="lockup-sm"):
    return f'<span class="lockup {cls}">{L(fn,"mk")}<span class="wm">o8</span></span>'

STATES=[("reviewing","Reviewing","Reading the diff. The default face."),
        ("approved","Approved","Merged, with a receipt."),
        ("sentback","Sent back","Changes requested."),
        ("working","Working","Waiting on an agent or CI.")]
TN={"fog":"fog","tight":"tight","hair":"hairline"}
def mk_sizes(): return "".join(f'<figure class="sz"><span class="szbox" style="width:{px}px;height:{px}px">{fog.svg(*fog.for_px(px),"reviewing","mk")}</span><figcaption>{px}px · {TN[fog.for_px(px)[0]]}</figcaption></figure>' for px in [160,64,48,32,24,16])
sizes=mk_sizes(); sizes_dark=mk_sizes()
states="".join(f'<figure class="st light">{fog.svg("fog","full",k,"mk st-mk")}<figcaption><b>{t}</b><span>{d}</span></figcaption></figure>' for k,t,d in STATES)
cstates="".join(f'<figure class="st light"><svg xmlns="http://www.w3.org/2000/svg" viewBox="{fog.VB}" class="mk st-mk" aria-hidden="true">{studies.color_static(k,b,dc)}</svg><figcaption><b>{t}</b><span>{d}</span></figcaption></figure>'
                for k,b,dc,t,d in studies.STATE_COLORS)

def logo_option(i, key, name, fn, idea, verdict):
    return f'''
    <article class="opt" id="logo-{key}">
      <header class="opt-head"><span class="opt-n">{chr(65+i)}</span><div><h3>{name}</h3><p>{idea}</p></div></header>
      <div class="opt-grid">
        <div class="opt-icons">
          <span class="appicon light s120">{L(fn,"mk lg-in")}</span>
          <span class="appicon dark s120">{L(fn,"mk lg-in")}</span>
          <span class="favs"><span class="fav-box light"><span class="f32">{L(fn,"mk")}</span><span class="f16">{L(fn,"mk")}</span></span><small>32 and 16px</small></span>
        </div>
        <div class="opt-locks">
          <div class="lk light">{l_lockup(fn,"lockup-md")}</div>
          <div class="lk dark">{l_lockup(fn,"lockup-md")}</div>
        </div>
      </div>
      <div class="hero mini">
        <nav class="hero-nav">{l_lockup(fn)}<span class="links"><span>Docs</span><span>Changelog</span><span>GitHub</span></span><span class="btn small">Download</span></nav>
        <div class="hero-body">
          <h4>Your agents write the code. o8 reviews it, sends it back until it’s right, and merges it.</h4>
          <div class="chip"><span class="avatar">{m("small","sentback")}</span><span><b>o8 sent #5938 back</b> 2 findings for Codex</span></div>
        </div>
      </div>
      <p class="verdict"><b>Honest take:</b> {verdict}</p>
    </article>'''
opts=logo_option(1,*logos.LOGOS[1]).replace('<span class="opt-n">B</span>','<span class="opt-n picked">✓</span>')

FACES=[("inter","Inter Tight","Free · Google Fonts · open license","Plain and very readable at small sizes in the app. The safe choice, but lots of products use Inter, so o8 looks less like itself."),]
def card(k,name,lic,verdict):
    return (f'<article class="facecard light" data-f="{k}"><p class="fc-label"><b>{name}</b><span>{lic}</span></p>'
            f'<div class="fc-lock"><span class="lockup lockup-md">{m()}<span class="wm">o8</span></span></div>'
            f'<p class="fc-head">Your agents write the code. o8 reviews it.</p>'
            f'<div class="fc-ui"><span class="avatar">{m("small","sentback")}</span><p><b>o8 reviewed #5938</b><span>Sent 2 findings back to Codex · v0.1.818</span></p></div>'
            f'<p class="fc-verdict">{verdict}</p></article>')
cards="".join(card(*f) for f in FACES)

LOCKED={"seal2","lanes","diff","intake","branches","color_states","intro_wake"}
def mo(fn_name, title, text):
    src=getattr(studies,fn_name) if hasattr(studies,fn_name) else getattr(morph,fn_name)
    badge='<em class="lock">Locked</em>' if fn_name in LOCKED else ''
    return f'<figure class="mo">{src()}<figcaption><b>{title}{badge}</b><span>{text}</span></figcaption></figure>'
INTROS=[("intro_wake","Wake","Ring holds, softens into Glance while it’s still half asleep: heavy eyes, a blink, a stretch, then the look right. The orange point drops last."),
        ("intro_draw","Draw","The orange point lands first and the ring draws itself around from it, then wakes the same way. Best for video openers."),
        ("intro_peek","Peek","The hole in the Ring blinks like one sleepy eye before it opens into two. The most character of the three.")]
intros="".join(mo(*i) for i in INTROS[:1])
work="".join(mo(*w) for w in studies.WORK)
brand="".join(mo(*b) for b in studies.BRAND if b[0] in ("color_states","ring_opens"))

def F(style="fog", size="full", state="reviewing", cls="mk"): return fog.svg(style,size,state,cls)
fog_treat="".join(f'<figure class="fg {th}">{F(k)}<figcaption><b>{fog.NAMES[k]}</b><span>{t}</span></figcaption></figure>'
   for th in ("light","dark") for k,t in [("fog","Dense middle, soft edge. Still clearly Glance. My pick."),("mist","Lighter all through, more ghost than pet. For big hero moments."),("core","Almost the old body, with a long soft fade outside it.")])
SURF=[("s-paper","Paper"),("s-card","App card"),("s-graph","Graphite"),("s-grad","Gradient backdrop")]
fog_surf="".join(f'<figure class="fs {c}{" dark" if c=="s-graph" else " light"}">{F("fog")}<figcaption>{n}</figcaption></figure>' for c,n in SURF)
SC={"reviewing":("#17140F","#FF5A1F"),"working":("#17140F","#A8A398"),"sentback":("#FF5A1F","#17140F"),"approved":("#15803D","#F4F2EC")}
fog_states="".join(f'<figure class="fst light" style="--g-body:{b};--g-dot:{d}">{F("fog","full",st)}<figcaption>{n}</figcaption></figure>' for st,(b,d),n in [(k,SC[k],l) for k,l in [("reviewing","Reviewing"),("working","Working"),("sentback","Sent back"),("approved","Approved")]])
SZ=[(64,"full","fog","64px fog"),(48,"full","fog","48px fog"),(32,"small","fog","32px fog ✗"),(32,"small","tight","32px tight"),(24,"small","tight","24px tight"),(20,"small","hair","20px hairline"),(16,"small","fog","16px fog ✗"),(16,"small","hair","16px hairline")]
fog_sizes="".join(f'<figure class="fz"><span style="width:{px}px;height:{px}px">{F(st,sz)}</span><figcaption>{lab}</figcaption></figure>' for px,sz,st,lab in SZ)
def fog_breathe():
    lay=fog.body_layers("fog")
    a='<animateTransform attributeName="transform" type="scale" dur="5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" values="1;1.06;1" keySplines="0.65 0 0.35 1;0.65 0 0.35 1"/>'
    g=fog.FULL
    inner=f'<g transform="translate(50 53)"><g>{a}<g transform="translate(-50 -53)">{lay}</g></g></g>'+fog.eyes(g,"reviewing","var(--g-eye)","var(--g-pupil)")+f'<circle cx="{g["dot"][0]}" cy="{g["dot"][1]}" r="{g["dr"]}" fill="var(--g-dot)"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{fog.VB}" class="morph" role="img" aria-label="Glance in fog, the fog slowly swelling and settling like breath">{inner}</svg>'
fog_breath=fog_breathe()
def fav(sz,st,px): return f'<span style="width:{px}px;height:{px}px;display:block">{F(st,sz)}</span>'
fog_win_rows=[("sentback","o8 reviewed <span class=\"mono\">#5938</span> serve task artifacts through o8d","Sent 2 findings back to Codex. I’ll re-review when the fix lands.","warn","Sent back"),
              ("working","Waiting on CI for <span class=\"mono\">#5941</span> sidebar spacing","Claude Code pushed a fix 2 minutes ago.","","Working"),
              ("approved","o8 approved <span class=\"mono\">#5913</span> themes and glass clarity","Merged <span class=\"mono\">a3f9c21</span> with a receipt.","ok","Merged")]
fog_win="".join(f'<div class="row"><span class="avatar fogav" style="--g-body:{SC[st][0]};--g-dot:{SC[st][1]}">{F("tight","small",st)}</span><div class="row-main"><p class="r-title">{t}</p><p class="r-sub">{sub}</p></div><span class="pill {pc}">{pl}</span></div>' for st,t,sub,pc,pl in fog_win_rows)
STEPS_HTML=loopdial.cards(m)
TODAY=loopdial.today().replace('class="mk"','class="mk today-ring"')

OX=' class="mk" aria-hidden="true"'
sys.path.insert(0, D+"/../gen")
from marks import svg_vars as old_mark
old="".join(f'<figure class="old light">{old_mark(n, extra=OX)}<figcaption>{t}</figcaption></figure>' for n,t in [("seal","Seal (now the Approve motion)"),("glance","Glance, first sketch")])+"".join(f'<figure class="old light">{logos.svg(f(),"mk")}<figcaption>{nm} logo</figcaption></figure>' for k,nm,f,_,_ in logos.LOGOS if k!="ring")

css=open(D+"/page2.css").read()+open(D+"/page3.css").read()+open(D+"/page4.css").read()+open(D+"/page5.css").read()+open(D+"/page7.css").read()+open(D+"/page8.css").read()
import json, working
WK_MINI=working.build("tight"); WK_BIG=working.build("fog"); WK_ALONE=working.build("fog")
MOTION_NAME={"thinking":"New resting loop","intake":"Many in, one out","diff":"Read the diff","sendback":"New, from the sent-back state","lanes":"Fan out","branches":"Branch review","to_merge":"Glance to Merge (not locked yet)","seal2":"Approve"}
STEP={"thinking":"Between jobs","arrive":"Loop step 1 · Arrive","review":"Loop step 2 · Review","sendback":"Loop step 3 · Send back","waiting":"While the agent fixes it","rereview":"Loop step 4 · Re-review","merging":"Loop step 5 · Merge","approved":"End of the loop"}
FN={k:fn for k,_,_,fn,_ in working.STATES}
wk_btns="".join(f'<button type="button" data-i="{i}" aria-pressed="false">{s["label"]}</button>' for i,s in enumerate(WK_MINI))
wk_alone="".join(f'<figure class="mo">{s["svg"]}<figcaption><span class="step">{STEP[s["key"]]}</span><b>{s["label"]}</b><span>“{s["line"]}”</span><span>{MOTION_NAME[FN[s["key"]]]}</span></figcaption></figure>' for s in WK_ALONE)
working_html=f"""  <section class="block" id="working">
    <h2>Working indicator v1 <span class="new">New</span></h2>
    <p class="sub">One Glance in the composer that changes motion as the agent’s state changes, with a line saying what it’s doing. A new state waits for the current loop to finish, when Glance is back at rest, and the next motion starts there. A 0.3s cross-fade covers the change between fog and hard edges, and the two loops that don’t rest on full Glance (Many in, one out rests smaller; Branch review starts with Glance riding in).</p>
    <div class="wk">
      <div class="scroll-x"><div class="win wk-win">
        <div class="win-bar"><span class="dots"><i></i><i></i><i></i></span><span class="crumb">o8-run/o8 <b>›</b> Review queue</span></div>
        <div class="wk-tr">
          <p class="u">Review what came in this morning and merge what’s ready.</p>
          <p class="a">On it. Three changes came in from Codex and Claude Code. I’ll review each one, send back anything that needs work, and merge when CI is green.</p>
        </div>
        <div class="wk-comp">
          <div class="wk-st"><span class="wk-mini" aria-hidden="true"></span><span class="wk-line" role="status">Thinking about what changed</span><span class="wk-time mono">0:00 · esc to stop</span></div>
          <div class="wk-in">Reply to o8, or type / for commands</div>
          <div class="wk-tools"><span class="chip">o8</span><span class="chip">o8-run/o8</span><span class="send" aria-hidden="true">↑</span></div>
        </div>
      </div></div>
      <div class="wk-stage"><div class="wk-big" aria-hidden="true"></div><p>The same indicator, large, so you can see each motion.</p></div>
    </div>
    <div class="wk-ctl" role="group" aria-label="Agent state">
      <button type="button" class="wk-play" aria-pressed="true">Pause demo</button>{wk_btns}
      <p class="hint">The demo walks through a full review. Tap a state to queue it; it starts the next time Glance lands.</p>
    </div>
    <h3 class="mo-group">Each state on its own</h3>
    <div class="motions wk-alone">{wk_alone}</div>
    <div class="rule"><b>How it maps:</b> taking in work is Many in, one out. Reviewing is Read the diff. Sending back turns Glance orange and sends the findings out. Waiting on CI is Fan out, the three lanes being the checks. Re-reviewing is Branch review. Merging is Glance to Merge. Approved is the seal, at the end. Thinking is the resting loop in between. Each state keeps its motion’s edge rule, so the indicator moves between fog and hard edges with the work. In the composer it uses tight fog at 40px.</div>
  </section>"""
wk_data=json.dumps({"mini":[{k:s[k] for k in ("key","label","line","svg","dur","loops")} for s in WK_MINI],"big":[s["svg"] for s in WK_BIG]}).replace("</","<\\/")
working_js='<script type="application/json" id="wk-data">'+wk_data+'</script>\n<script>'+open(D+"/studies_working.js").read()+'</script>'

html=f'''<title>o8 mark: Ring and Glance</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>{css}</style>
<main class="page" data-face="inter">
  <header class="intro">
    <p class="eyebrow">o8 brand · round 8 · Nov 12, 2026</p>
    <h1>Ring and Glance</h1>
    <p class="lede">Ring is the logo: a heavy o with an orange point, and if you look long enough it reads o8. Glance is the pet that lives inside the product. Glance is now fog everywhere: its body fades into whatever it sits on, while the eyes and orange dot stay sharp. That includes the small sizes and every locked motion.</p>
    <p class="locked"><b>Locked:</b> Ring · Wake intro · the loop saga · Inter Tight · the reviewing face · Approve · Fan out · Read the diff · Many in, one out · Branch review · color states · Glance in the o8 window · Fog</p>
    <nav class="toc" aria-label="On this page"><a href="#working">Working</a><a href="#logos">Ring</a><a href="#fog">Fog</a><a href="#intro">Intro</a><a href="#story">Story</a><a href="#motion">Motion</a><a href="#states">States</a><a href="#type">Type</a><a href="#glance">Glance at every size</a></nav>
  </header>

{working_html}

  <section class="block" id="logos">
    <h2>Ring, the main logo</h2>
    <p class="sub">On the dock, the download button and the X avatar. Glance shows up inside the product, on reviews and in motion.</p>
    <div class="opts">{opts}</div>
  </section>


  <section class="block" id="fog">
    <h2>Glance in fog<em class="lock">Locked</em></h2>
    <p class="sub">No hard body. The pebble becomes fog: solid in the middle, fading evenly outward into nothing, so Glance sits in any surface instead of on top of it. The eyes and the orange dot stay crisp, because that’s where the character is. Ring and everything else stays flat.</p>
    <div class="fogs">{fog_treat}</div>

    <h3 class="mo-group">On any surface</h3>
    <div class="fsurf">{fog_surf}</div>

    <h3 class="mo-group">States in fog</h3>
    <p class="sub">The locked color states carry over: the fog takes the state color.</p>
    <div class="fstates">{fog_states}</div>

    <h3 class="mo-group">Small sizes</h3>
    <p class="sub">Full fog smudges below 48px (the ✗ ones), so the fade shrinks with the size. Tight from 24 to 40px keeps a visible soft edge of a pixel or two. Hairline at 16 and 20px is the honest limit: the face reads fine, but the fade is under a pixel, so it looks nearly flat. The app icon and favicon stay Ring.</p>
    <div class="fsizes light">{fog_sizes}</div>

    <h3 class="mo-group">Motion</h3>
    <div class="motions one"><figure class="mo">{fog_breath}<figcaption><b>Breathing fog</b><span>The fog swells about 6% and settles every five seconds. The face never moves. Pauses with the rest of the motion.</span></figcaption></figure></div>

    <div class="rule"><b>The rule:</b> Fog at 48px and up, tight from 24 to 40px, hairline at 16 and 20px, never below 16px. Motions follow the edge rules in the Motion section. Ring, the app icon and the favicon stay flat. Mist is for big backdrops only.</div>
  </section>

  <section class="block" id="intro">
    <h2>Intro: Wake</h2>
    <p class="sub">Ring holds, crisp and flat, then softens into fog Glance while it’s still half asleep, and the orange point drops last. It goes back to a flat Ring at the end, so the logo itself is never fogged.</p>
    <div class="motions">{intros}</div>
  </section>

  <section class="block" id="story">
    <h2>A story to hold it together</h2>
    <p class="sub">What Sofiane’s post does well, and a saga built on what o8 actually does.</p>
    <div class="story">
      <article class="scard">
        <h3>What Sishen Security does</h3>
        <p class="quote">“A security startup built on the four guardians of Chinese mythology. One beast watches each side of your company.”</p>
        <ul>
          <li><b>One sentence holds the world.</b> You get the whole brand from the caption.</li>
          <li><b>The myth maps to the product.</b> Each beast owns one area of security, so the story is also the feature list.</li>
          <li><b>Detail in the art, restraint in the type.</b> Chrome-rendered guardians next to a plain mono font; a reply calls that pairing out.</li>
        </ul>
        <p class="fine">I could read the captions and replies, but not the images or video, so this is from the words only.</p>
      </article>
      <article class="scard">
        <h3>What o8 can borrow</h3>
        <ul>
          <li><b>One sentence:</b> every change gets a second pair of eyes.</li>
          <li><b>A canon that maps 1:1:</b> each part of the story is one real thing o8 does, never two.</li>
          <li><b>Restraint:</b> their art is detailed; ours stays flat. What carries over is the story, not the chrome.</li>
        </ul>
      </article>
    </div>

    <h3 class="mo-group">The saga is the loop <em class="lock">Locked</em></h3>
    <p class="sub">No made-up names. o8’s story is the six steps it already takes with every change, from the README and roadmap on main today. Each step has its own spot for the Ring’s point, starting at the logo’s home. The era is whichever step o8 is making real right now, and the loop closing is 1.0.</p>
    <div class="today light">{TODAY}<p><b>Today: the Re-review era.</b> Small orange dots are steps that work on main, the big point is the one being built, and the paper dots are still ahead.</p></div>
    <div class="steps">{STEPS_HTML}</div>

    <h3 class="mo-group">How it shows up</h3>
    <div class="shows">
      <article class="scard"><h3>In the app</h3><p>The same six words are the status of every piece of work in the sidebar, and Glance wears the matching face. Settings → About shows the Ring with the current step’s point.</p></article>
      <article class="scard"><h3>On the site</h3><p>One strip of six steps under the hero. Steps that work today are solid, the one being built has the orange point, the rest are outlines. It updates when a step ships.</p></article>
      <article class="scard"><h3>In release posts</h3><p>Every post leads with its step: “o8 0.1.82x · Re-review. Fixes now get checked against the saved findings.” The clip is the locked motion for that step.</p></article>
    </div>

    <div class="rule"><b>The rule that keeps us in line:</b> every release names the step it moves forward, and only claims a step once it works on main. If work doesn’t move one of the six, it waits. Logo and Glance stay flat.</div>
  </section>

  <section class="block" id="motion">
    <h2>Motion studies</h2>
    <p class="sub">Glance acting out what o8 does. Edges follow your rule: Fan out, Read the diff and Branch review are hard edged. Approve is fog while it’s Glance and goes hard as it becomes the seal with the check. Many in, one out is fog on the in side and sharp on the out side. The ones you called fire are locked; the rest are still up for grabs.</p>
    <button class="pause" type="button" aria-pressed="false">Pause motion</button>
    <h3 class="mo-group">What o8 does</h3>
    <div class="motions">{work}</div>
    <h3 class="mo-group">Brand moments</h3>
    <div class="motions">{brand}</div>
  </section>

  <section class="block" id="states">
    <h2>States, in black and white or in color</h2>
    <p class="sub">The face alone tells the state, so color is extra, never the only signal. With color, sent back is the one time Glance itself turns orange, and approved borrows the green the app already uses for merged.</p>
    <p class="row-label">Mono, the current default</p>
    <div class="states">{states}</div>
    <p class="row-label">Color option</p>
    <div class="states">{cstates}</div>
  </section>

  <section class="block" id="type">
    <h2>Inter Tight<em class="lock">Locked</em></h2>
    <p class="sub">Free on Google Fonts under an open license. Wordmark at weight 500 with tight spacing, headlines at 300, JetBrains Mono for code.</p>
    <div class="faces one">{cards}</div>
  </section>

  <section class="block" id="glance">
    <h2>Glance at every size</h2>
    <p class="sub">Fog at 48px and up. Below that the small cut (bigger eyes and dot) with a tighter fade: tight at 24 to 32px, hairline at 16px.</p>
    <div class="sizes light">{sizes}</div>
    <div class="sizes dark">{sizes_dark}</div>
  </section>

  <section class="block">
    <h2>Glance in the o8 window<em class="lock">Locked</em></h2>
    <p class="sub">30px avatars in tight fog, wearing the color states.</p>
    <div class="scroll-x"><div class="win">
      <div class="win-bar"><span class="dots"><i></i><i></i><i></i></span><span class="crumb">o8-run/o8 <b>›</b> Review queue</span></div>
      <div class="win-body">{fog_win}</div>
    </div></div>
  </section>

  <section class="block rules">
    <h2>Rules so far</h2>
    <ul>
      <li><b>Two marks, two jobs:</b> Ring stands for the app and stays flat; Glance stands for the agent and is fog. Never put both side by side as a lockup.</li>
      <li><b>Colors:</b> ink and paper, one orange point. Glance only turns orange to say “sent back”.</li>
      <li><b>Fog:</b> Glance’s body is always fog. Full fog at 48px and up, tight from 24 to 40px, hairline at 16 and 20px, never below 16px. Eyes and the orange dot stay crisp.</li>
      <li><b>Character:</b> eyes look right by default. No brows, arms, hats or extra faces. Detail gets added slowly, if at all.</li>
      <li><b>Motion:</b> every loop starts and ends on Glance, eases in and out, and pauses when the system asks for reduced motion.</li>
    </ul>
  </section>

  <details class="block explored">
    <summary>Dropped directions</summary>
    <p class="sub">Otter, Sprout, and the Pebble and Merge logos are out.</p>
    <div class="olds">{old}</div>
  </details>
</main>
<script>
(function(){{
  var btn=document.querySelector('.pause'), svgs=[].slice.call(document.querySelectorAll('svg.morph'));
  function set(p){{ svgs.forEach(function(s){{ try{{ p?s.pauseAnimations():s.unpauseAnimations(); }}catch(e){{}} }}); btn.setAttribute('aria-pressed',p?'true':'false'); btn.textContent=p?'Play motion':'Pause motion'; }}
  var paused=false;
  try{{ paused=window.matchMedia('(prefers-reduced-motion: reduce)').matches; }}catch(e){{}}
  if(paused) set(true);
  btn.addEventListener('click',function(){{ paused=!paused; set(paused); }});
}})();
document.querySelectorAll('input[name="face"]').forEach(function(r){{
  r.addEventListener('change', function(){{ document.querySelector('.page').dataset.face = r.value; }});
}});
</script>
{working_js}
'''
open(sys.argv[2],'w').write(html); print(len(html))
