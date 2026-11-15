"""o8's working indicator (v1): one Glance that flows between the locked motions as the agent's state changes.
Every motion starts and ends on the same resting Glance, so a state change waits for the current loop to land
there and the next motion starts from that exact frame. No crossfade needed, nothing jumps."""
import fog, studies
from studies import A, T, about, wrap, FOG, face, body_path, DOT, DR, INK, PAPER, ACC, GREY, g

def thinking():
    """Resting loop: the fog breathes and the eyes read left to right, like scanning a line."""
    D="4s"
    body=about(50,53,T("scale",[0,.5,1],["1","1.05","1"],D),FOG(f'<path d="{body_path()}" fill="{INK}"/>'))
    eyes=""
    for ex,ey in g["eyes"]:
        eyes+=f'<ellipse cx="{ex}" cy="{ey}" rx="{g["erx"]}" ry="{g["ery"]}" fill="{PAPER}"/>'
        px=ex+g["pdx"]; py=ey+g["pdy"]
        kt=[0,.18,.30,.62,.80,1]
        eyes+=(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="{g["pr"]}" fill="{INK}">'
               f'{A("cx",kt,[px,px,ex-g["pdx"]*.7,ex-g["pdx"]*.7,px,px],D)}</circle>')
    dot=f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}">{A("r",[0,.5,1],[DR,DR*0.8,DR],D)}</circle>'
    return wrap(body+eyes+dot,"Glance at rest: the fog breathes and its eyes read across a line and back")

def sendback():
    """Glance turns orange with the sent-back face and sends two findings back out to the left."""
    D="6s"; kt=[0,.12,.22,.78,.88,1]
    body=FOG(f'<path d="{body_path()}" fill="{INK}">{A("fill",kt,[INK,INK,ACC,ACC,INK,INK],D)}</path>')
    calm=f'<g>{A("opacity",[0,.12,.17,.84,.89,1],[1,1,0,0,1,1],D)}{face("reviewing")}</g>'
    sb=f'<g opacity="0">{A("opacity",[0,.12,.17,.84,.89,1],[0,0,1,1,0,0],D)}{face("sentback")}</g>'
    dot=f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}">{A("fill",kt,[ACC,ACC,INK,INK,ACC,ACC],D)}</circle>'
    cards=""
    for i,y in enumerate([62,72]):
        s=.30+i*.14
        cards+=(f'<g opacity="0">{A("opacity",[0,s,s+.03,s+.20,s+.26,1],[0,0,1,1,0,0],D,"linear")}'
                f'<g>{T("translate",[0,s,s+.24,1],["0 0","0 0","-40 0","-40 0"],D)}'
                f'<rect x="16" y="{y-4}" width="22" height="8" rx="3" fill="{PAPER}"/>'
                f'<rect x="19" y="{y-1}" width="11" height="2" rx="1" fill="{ACC}"/></g></g>')
    shake=T("translate",[0,.20,.23,.26,.29,1],["0 0","0 0","-2 0","2 0","0 0","0 0"],D)
    return wrap(about(50,53,shake,body+calm+sb+dot)+cards,
                "Glance turns orange with a flat, level look and sends two findings back out to the left, then settles")

# key, label, the line it shows, the motion, how long the demo holds it (loops)
STATES=[
 ("thinking","Thinking","Thinking about what changed","thinking",1),
 ("arrive","Taking in work","Taking in 3 changes from Codex and Claude Code","intake",1),
 ("review","Reviewing","Reviewing #5938 · 14 files","diff",1),
 ("sendback","Sending back","Sending 2 findings back to Codex","sendback",1),
 ("waiting","Waiting on CI","Waiting on CI · 3 checks running","lanes",1),
 ("rereview","Re-reviewing","Re-reviewing the fix against 2 saved findings","branches",1),
 ("merging","Merging","Merging #5938 into main","to_merge",1),
 ("approved","Approved","Approved and merged · a3f9c21 · receipt saved","seal2",1),
]
NOTE={"thinking":"New. The resting loop between jobs.","sendback":"New. Built from the sent-back color state.",
      "merging":"Uses Glance to Merge, which isn’t locked yet."}

def _fn(name): return globals()[name] if name in globals() else getattr(studies,name)
def _dur(svg):
    import re
    return float(re.search(r'dur="([\d.]+)s"',svg).group(1))

def build(style):
    fog.DEFAULT[0]=style
    try:
        out=[]
        for key,label,line,fn,loops in STATES:
            s=_fn(fn)()
            out.append(dict(key=key,label=label,line=line,svg=s,dur=_dur(s),loops=loops))
        return out
    finally:
        fog.DEFAULT[0]="fog"
