"""Round-3 motion studies: abstract loops that act out what o8 does, plus brand moments.
Every loop starts and ends on Glance (or on a logo, for the logo studies)."""
import math
from fog import FOG
from glance import FULL, eyes, body_path, INK, PAPER, ACC
from morph import polar, to_d, pebble_poly, ellipse_poly, seal_poly, wrap
import logos

GREY="#A8A398"; GREEN="#15803D"; HAIR="#CFCAC0"
E="0.65 0 0.35 1"
PEB=polar([pebble_poly()])
CIRC=polar([ellipse_poly(50,52,37,37)])
SEAL=polar([seal_poly()])
CARD=None

def A(attr, kt, vals, dur, mode="spline", extra=""):
    n=len(kt)
    ks=f' keySplines="{";".join([E]*(n-1))}"' if mode=="spline" else ""
    return (f'<animate attributeName="{attr}" dur="{dur}" repeatCount="indefinite" calcMode="{mode}"'
            f' keyTimes="{";".join(str(k) for k in kt)}"{ks} values="{";".join(str(v) for v in vals)}"{extra}/>')
def T(typ, kt, vals, dur, mode="spline"):
    n=len(kt)
    ks=f' keySplines="{";".join([E]*(n-1))}"' if mode=="spline" else ""
    return (f'<animateTransform attributeName="transform" type="{typ}" dur="{dur}" repeatCount="indefinite" calcMode="{mode}"'
            f' keyTimes="{";".join(str(k) for k in kt)}"{ks} values="{";".join(str(v) for v in vals)}"/>')
def about(cx, cy, anim, inner):
    return f'<g transform="translate({cx} {cy})"><g>{anim}<g transform="translate({-cx} {-cy})">{inner}</g></g></g>'

def superellipse(cx, cy, a, b, n, M=360):
    pts=[]
    for i in range(M):
        t=2*math.pi*i/M; c,s=math.cos(t),math.sin(t)
        pts.append((cx+a*math.copysign(abs(c)**(2/n),c), cy+b*math.copysign(abs(s)**(2/n),s)))
    return pts
CARD=polar([superellipse(50,52,33,38,5)])
SEED=[(50+0.2*(x-50),83+0.2*(y-52)) for x,y in PEB]

g=FULL; DOT=g["dot"]; DR=g["dr"]
def face(state="reviewing", pupil=INK): return eyes(g,state,PAPER,pupil)

def plen(d, steps=400):
    # rough length of a path made of M/V/H/C commands (enough for dash animations)
    import re
    tok=re.findall(r'[MVHCL]|-?[\d.]+', d); i=0; x=y=0; L=0; cmd=None
    while i<len(tok):
        if tok[i] in "MVHCL": cmd=tok[i]; i+=1; continue
        if cmd=="M": x,y=float(tok[i]),float(tok[i+1]); i+=2
        elif cmd=="V": ny=float(tok[i]); L+=abs(ny-y); y=ny; i+=1
        elif cmd=="H": nx=float(tok[i]); L+=abs(nx-x); x=nx; i+=1
        elif cmd=="L": nx,ny=float(tok[i]),float(tok[i+1]); L+=math.hypot(nx-x,ny-y); x,y=nx,ny; i+=2
        elif cmd=="C":
            p=[(x,y)]+[(float(tok[i+k]),float(tok[i+k+1])) for k in (0,2,4)]; i+=6; px,py=x,y
            for s in range(1,steps+1):
                t=s/steps; mt=1-t
                qx=mt**3*p[0][0]+3*mt*mt*t*p[1][0]+3*mt*t*t*p[2][0]+t**3*p[3][0]
                qy=mt**3*p[0][1]+3*mt*mt*t*p[1][1]+3*mt*t*t*p[2][1]+t**3*p[3][1]
                L+=math.hypot(qx-px,qy-py); px,py=qx,qy
            x,y=p[3]
    return round(L+0.5,1)

def draw(d, L, kt, vals, dur, stroke=INK, w=15, extra_anim=""):
    return (f'<path d="{d}" stroke="{stroke}" stroke-width="{w}" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="{L} {L+2}" stroke-dashoffset="{vals[0]}">'
            f'{A("stroke-dashoffset",kt,vals,dur)}{extra_anim}</path>')

# 1. Approve: the seal, redone as a staged stamp
def seal2():
    D="7s"
    body=(f'<path d="{to_d(PEB)}" fill="{INK}">'
          f'{A("d",[0,.12,.24,.36,.76,.90,1],[to_d(PEB),to_d(PEB),to_d(CIRC),to_d(SEAL),to_d(SEAL),to_d(PEB),to_d(PEB)],D)}'
          f'{A("fill",[0,.24,.36,.76,.88,1],[INK,INK,ACC,ACC,INK,INK],D)}</path>')
    body=(f'<g>{A("opacity",[0,.28,.34,.76,.82,1],[1,1,0,0,1,1],D)}'+FOG(body,cx=50,cy=52)+'</g>'+f'<g opacity="0">{A("opacity",[0,.18,.28,.80,.90,1],[0,0,1,1,0,0],D)}'+body+'</g>')
    body=about(50,52,T("rotate",[0,.24,.42,.70,.701,1],[0,0,20,20,0,0],D),body)
    eyes_g=(f'<g>{A("opacity",[0,.13,.16,.88,.91,1],[1,1,0,0,1,1],D)}'
            + about(50,50,T("scale",[0,.10,.16,.86,.92,1],["1 1","1 1","1 0.08","1 0.08","1 1","1 1"],D),face())+'</g>')
    dot=(f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}">'
         f'{A("cx",[0,.18,.32,.84,.94,1],[DOT[0],DOT[0],50,50,DOT[0],DOT[0]],D)}{A("cy",[0,.18,.32,.84,.94,1],[DOT[1],DOT[1],52,52,DOT[1],DOT[1]],D)}'
         f'{A("r",[0,.18,.32,.84,.94,1],[DR,DR,0,0,DR,DR],D)}</circle>')
    ring=(f'<circle cx="50" cy="52" r="29.5" fill="none" stroke="{PAPER}" stroke-width="1.6" stroke-dasharray="2.2 3.2" opacity="0">'
          f'{A("opacity",[0,.44,.50,.74,.78,1],[0,0,1,1,0,0],D)}</circle>')
    L=47
    check=draw("M34.5 53.5 L45 64 L66.5 41.5",L,[0,.46,.58,.72,.77,1],[L,L,0,0,L,L],D,stroke=PAPER,w=7.5)
    stamp=about(50,52,T("scale",[0,.36,.41,.46,.50,1],["1","1","0.9","1.04","1","1"],D),body+dot+ring+check)
    return wrap(stamp+eyes_g,"Glance closes its eyes, tightens into a round seal, turns orange, stamps and draws a check")

# 2. Fan out: one Glance splits into three agents, each finishes, they merge back
def lanes():
    D="7s"
    def mini(dx, done_at, bob_at):
        b=bob_at
        inner=(f'<path d="{body_path()}" fill="{INK}"/>'+
               f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR*2.2}" fill="{GREY}">{A("fill",[0,done_at,done_at+.04,1],[GREY,GREY,ACC,ACC],D)}</circle>')
        inner=about(50,53,'',f'<g transform="translate(50 53) scale(0.32) translate(-50 -53)">{inner}</g>')
        bob=T("translate",[0,b,b+.04,b+.08,1],["0 0","0 0","0 -4","0 0","0 0"],D)
        return (f'<g opacity="0">{A("opacity",[0,.12,.14,.75,.77,1],[0,0,1,1,0,0],D,"linear")}'
                f'<g>{T("translate",[0,.12,.26,.62,.76,1],["0 0","0 0",f"{dx} 0",f"{dx} 0","0 0","0 0"],D)}<g>{bob}{inner}</g></g></g>')
    rails=(draw("M50 72 H16",34,[0,.16,.28,.62,.74,1],[34,34,0,0,34,34],D,stroke=HAIR,w=1.6)
           + draw("M50 72 H84",34,[0,.16,.28,.62,.74,1],[34,34,0,0,34,34],D,stroke=HAIR,w=1.6))
    main_dot=(f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}">'
              f'{A("fill",[0,.12,.16,.44,.48,1],[ACC,ACC,GREY,GREY,ACC,ACC],D)}{A("r",[0,.12,.20,.70,.80,1],[DR,DR,DR*2.2,DR*2.2,DR,DR],D)}</circle>')
    main_eyes=f'<g>{A("opacity",[0,.10,.13,.80,.84,1],[1,1,0,0,1,1],D)}{face()}</g>'
    main=f'<path d="{body_path()}" fill="{INK}"/>'+main_eyes+main_dot
    main=about(50,53,T("scale",[0,.10,.22,.70,.82,1],["1","1","0.32","0.32","1","1"],D),
               about(50,53,T("translate",[0,.32,.36,.40,1],["0 0","0 0","0 -10","0 0","0 0"],D),main))
    return wrap(rails+mini(-32,.38,.28)+mini(32,.54,.44)+main,
                "Glance splits into three small agents in parallel lanes, each one finishes, and they merge back into one")

# 3. Read the diff: Glance becomes a card of lines, a scan bar reads down, one line is flagged
def diff():
    D="7.5s"
    body=(f'<path d="{to_d(PEB)}" fill="{INK}">{A("d",[0,.10,.22,.78,.90,1],[to_d(PEB),to_d(PEB),to_d(CARD),to_d(CARD),to_d(PEB),to_d(PEB)],D)}</path>')
    eyes_g=f'<g>{A("opacity",[0,.10,.15,.86,.92,1],[1,1,0,0,1,1],D)}{face()}</g>'
    dot=f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}">{A("r",[0,.10,.16,.86,.92,1],[DR,DR,0,0,DR,DR],D)}</circle>'
    widths=[42,30,46,22,38,28]; rows=""
    for i,w in enumerate(widths):
        y=30+i*8.6; t0=.20+i*.018
        col=A("stroke",[0,.50,.53,.80,.84,1],[PAPER,PAPER,ACC,ACC,PAPER,PAPER],D) if i==3 else ""
        ind=6 if i in (2,3) else 0
        rows+=(f'<path d="M{27+ind} {y:.1f} H{27+ind+w-ind}" stroke="{PAPER}" stroke-width="3.6" stroke-linecap="round" opacity="0">'
               f'{A("opacity",[0,t0,t0+.06,.74,.79,1],[0,0,1,1,0,0],D)}{col}</path>')
    ys=[30+i*8.6-4.5 for i in range(6)]
    bar=(f'<rect x="20" y="0" width="60" height="9" rx="2.5" fill="{PAPER}" opacity="0">'
         f'{A("opacity",[0,.28,.31,.66,.70,1],[0,0,.16,.16,0,0],D,"linear")}'
         f'{A("y",[0,.30,.48,.56,.68,1],[ys[0],ys[0],ys[3],ys[3],ys[5],ys[5]],D)}</rect>')
    return wrap(body+eyes_g+dot+rows+bar,"Glance turns into a card of diff lines, a scan bar reads down them and one line is flagged orange")

# 4. Many in, one out: small changes go in, one merged change comes out
_hs=[0]
def half_sharp(el, x0=34, x1=66):
    """Fog on the left (in) side, hard edge on the right (out) side: a flat copy faded in left to right over the fog."""
    _hs[0]+=1; k=f"hs{_hs[0]}"
    return (FOG(el)+f'<defs><linearGradient id="{k}g" gradientUnits="userSpaceOnUse" x1="{x0}" y1="0" x2="{x1}" y2="0">'
            f'<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>'
            f'<mask id="{k}m" maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140"><rect x="-20" y="-20" width="140" height="140" fill="url(#{k}g)"/></mask></defs>'
            f'<g mask="url(#{k}m)">{el}</g>')

# 4. Many in, one out
def intake():
    D="6.5s"; out=f'<path d="M-2 53 H24 M76 53 H102" stroke="{HAIR}" stroke-width="1.4" stroke-dasharray="2 3"/>'
    for i,y in enumerate([53,53,53,53]):
        s=.04+i*.10
        out+=f'<circle cx="-8" cy="{y}" r="3.6" fill="{GREY}">{A("cx",[0,s,s+.22,1],[-8,-8,36,36],D,"linear")}</circle>'
    out+=f'<circle cx="60" cy="53" r="5.4" fill="{ACC}">{A("cx",[0,.60,.84,1],[60,60,114,114],D)}</circle>'
    pupils=""
    for ex,ey in g["eyes"]:
        pupils+=(f'<ellipse cx="{ex}" cy="{ey}" rx="{g["erx"]}" ry="{g["ery"]}" fill="{PAPER}"/>'
                 f'<circle cx="{ex+g["pdx"]}" cy="{ey+g["pdy"]}" r="{g["pr"]}" fill="{INK}">'
                 f'{A("cx",[0,.04,.10,.52,.60,1],[ex+g["pdx"],ex+g["pdx"],ex-g["pdx"],ex-g["pdx"],ex+g["pdx"],ex+g["pdx"]],D)}</circle>')
    body=half_sharp(f'<path d="{body_path()}" fill="{INK}"/>')
    squash=T("scale",[0,.56,.60,.65,1],["1 1","1 1","1.05 0.94","1 1","1 1"],D)
    gl=f'<g transform="translate(50 53) scale(0.62) translate(-50 -53)">'+about(50,89,squash,body+pupils+f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}"/>')+'</g>'
    return wrap(out+gl,
                "Small grey changes slide into Glance from the left while it watches, then one orange merged change comes out the right")

# 5. Glance to Merge: the sprout movement, reworked into branches joining
LBR="M50 63 C50 43 27 47 27 27 V15"; RBR="M50 63 C50 43 73 47 73 27 V15"; TRUNK="M50 78 V63"
def to_merge():
    D="7s"; lb=plen(LBR); tr=plen(TRUNK)
    body=(f'<path d="{to_d(PEB)}" fill="{INK}">{A("d",[0,.12,.26,.76,.88,1],[to_d(PEB),to_d(PEB),to_d(SEED),to_d(SEED),to_d(PEB),to_d(PEB)],D)}'
          f'{A("fill",[0,.18,.28,.74,.84,1],[INK,INK,ACC,ACC,INK,INK],D)}</path>')
    body=FOG(body,cx=50,cy=52)
    eyes_g=f'<g>{A("opacity",[0,.12,.17,.86,.91,1],[1,1,0,0,1,1],D)}{face()}<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}"/></g>'
    trunk=draw(TRUNK,tr,[0,.28,.34,.68,.74,1],[tr,tr,0,0,tr,tr],D)
    lbr=draw(LBR,lb,[0,.32,.46,.62,.70,1],[lb,lb,0,0,lb,lb],D)
    rbr=draw(RBR,lb,[0,.35,.49,.62,.70,1],[lb,lb,0,0,lb,lb],D)
    tips=""
    for x,t in [(27,.46),(73,.49)]:
        tips+=(f'<circle cx="{x}" cy="15" r="0" fill="{GREY}">{A("r",[0,t,t+.03,.58,.62,1],[0,0,4.2,4.2,0,0],D)}'
               f'{A("fill",[0,t+.05,t+.07,1],[GREY,GREY,PAPER,PAPER],D)}</circle>')
    return wrap(trunk+lbr+rbr+tips+body+eyes_g,
                "Glance shrinks to an orange point, two branches grow from it, each tip is reviewed, and they merge back down into Glance")

# 6. Branch review: Glance rides the main line; one branch merges in, one is sent back
def branches():
    D="8s"
    A_D="M14 60 C24 60 22 38 32 38 H44 C54 38 52 60 62 60"; B_D="M40 60 C50 60 48 80 58 80 H70 C80 80 78 60 88 60"
    la,lbb=plen(A_D),plen(B_D)
    fadeall=A("opacity",[0,.05,.90,.96,1],[0,1,1,0,0],D,"linear")
    main=f'<path d="M4 60 H96" stroke="{INK}" stroke-width="3" stroke-linecap="round"/>'
    bra=(f'<path d="{A_D}" stroke="{GREY}" stroke-width="3" fill="none" stroke-linecap="round">{A("stroke",[0,.52,.56,1],[GREY,GREY,INK,INK],D)}</path>'
         + "".join(f'<circle cx="{x}" cy="38" r="3.2" fill="{GREY}">{A("fill",[0,.52,.56,1],[GREY,GREY,INK,INK],D)}</circle>' for x in (34,42)))
    brb=(f'<path d="{B_D}" stroke="{GREY}" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="{lbb} {lbb+2}" stroke-dashoffset="0">'
         f'{A("stroke",[0,.60,.63,1],[GREY,GREY,ACC,ACC],D)}{A("stroke-dashoffset",[0,.66,.80,1],[0,0,lbb,lbb],D)}</path>'
         + "".join(f'<circle cx="{x}" cy="80" r="3.2" fill="{GREY}">{A("fill",[0,.60,.63,1],[GREY,GREY,ACC,ACC],D)}{A("opacity",[0,.66,.72,1],[1,1,0,0],D)}</circle>' for x in (60,68)))
    commits="".join(f'<circle cx="{x}" cy="60" r="3.2" fill="{INK}"/>' for x in (10,30,76,94))
    s=0.24
    mini=(f'<g transform="translate(0 {60-89*s:.2f}) scale({s})"><path d="{body_path()}" fill="{INK}"/>{face()}'
          f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}"/></g>')
    rider=(f'<g>{T("translate",[0,.06,.86,1],["-14 0","-14 0","106 0","106 0"],D,"linear")}'
           f'<g>{T("translate",[0,.50,.53,.56,.60,.63,.66,1],["0 0","0 0","0 -3","0 0","0 0","0 -3","0 0","0 0"],D)}'
           f'<g transform="translate(-12 0)">{mini}</g></g></g>')
    return wrap(f'<g>{fadeall}{bra}{brb}{main}{commits}</g>'+rider,
                "Glance rides along the main line; the first branch it reaches merges in, the second turns orange and is sent back")

# 7. Color states: the four faces with colour
STATE_COLORS=[("reviewing",INK,ACC,"Reviewing","Ink body, orange dot. The default."),
              ("working",INK,GREY,"Working","Ink body, grey dot that breathes."),
              ("sentback",ACC,INK,"Sent back","Orange body. The one time Glance goes orange."),
              ("approved",GREEN,PAPER,"Approved","Green body, happy eyes. Merged.")]
def color_states():
    D="8s"; kts=[0,.22,.25,.47,.50,.72,.75,.97,1]
    seq=[c[1] for c in STATE_COLORS]; dseq=[c[2] for c in STATE_COLORS]
    def hold(vals): return [vals[0],vals[0],vals[1],vals[1],vals[2],vals[2],vals[3],vals[3],vals[0]]
    body=FOG(f'<path d="{body_path()}" fill="{INK}">{A("fill",kts,hold(seq),D)}</path>')
    fs=""
    for i,(st,_,_,_,_) in enumerate(STATE_COLORS):
        v=["0"]*4; v[i]="1"; kt=[0,.235,.485,.735]
        fs+=f'<g opacity="{v[0]}">{A("opacity",kt,v,D,"discrete")}{face(st)}</g>'
    dot=(f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{ACC}">{A("fill",kts,hold(dseq),D)}'
         f'{A("r",[0,.30,.36,.42,.47,1],[DR,DR,DR*0.6,DR,DR,DR],D)}</circle>')
    return wrap(body+fs+dot,"Glance cycling through reviewing, working, sent back and approved, with its body colour changing")

def color_static(st, bodyc, dotc):
    return (FOG(f'<path d="{body_path()}" fill="{bodyc}"/>')+f'{face(st, INK if bodyc!=INK else INK)}'
            f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DR}" fill="{dotc}"/>')

# 8. Pebble logo wakes into Glance
def pebble_wakes():
    D="5s"; out=f'<path d="{body_path()}" fill="{INK}"/>'
    for ex,ey in g["eyes"]:
        out+=(f'<ellipse cx="{ex}" cy="{ey}" rx="{g["erx"]}" ry="0" fill="{PAPER}">{A("ry",[0,.22,.32,.36,.40,.80,.88,1],[0,0,g["ery"],g["ery"]*0.15,g["ery"],g["ery"],0,0],D)}</ellipse>'
              f'<circle cx="{ex}" cy="{ey+g["pdy"]}" r="{g["pr"]}" fill="{INK}" opacity="0">{A("opacity",[0,.30,.32,.80,.84,1],[0,0,1,1,0,0],D,"linear")}'
              f'{A("cx",[0,.42,.52,1],[ex,ex,ex+g["pdx"],ex+g["pdx"]],D)}</circle>')
    out+=(f'<circle cx="59" cy="71.5" r="7" fill="{ACC}">{A("r",[0,.18,.30,.82,.92,1],[7,7,DR,DR,7,7],D)}'
          f'{A("cx",[0,.18,.30,.82,.92,1],[59,59,DOT[0],DOT[0],59,59],D)}{A("cy",[0,.18,.30,.82,.92,1],[71.5,71.5,DOT[1],DOT[1],71.5,71.5],D)}</circle>')
    return wrap(out,"The Pebble logo opens its eyes and becomes Glance, then closes them again")

# 9. Ring logo opens into Glance
def ring_opens():
    D="6s"; R=logos.RING
    RINGO=polar([ellipse_poly(R["cx"],R["cy"],R["ro"],R["ro"])])
    kt=[0,.16,.36,.70,.88,1]
    out=f'<path d="{to_d(RINGO)}" fill="{INK}">{A("d",kt,[to_d(RINGO),to_d(RINGO),to_d(PEB),to_d(PEB),to_d(RINGO),to_d(RINGO)],D)}</path>'
    out+=(f'<circle cx="{R["cx"]}" cy="{R["cy"]}" r="{R["ri"]}" fill="{PAPER}">{A("r",kt,[R["ri"],R["ri"],0,0,R["ri"],R["ri"]],D)}'
          f'{A("cy",kt,[R["cy"],R["cy"],52,52,R["cy"],R["cy"]],D)}</circle>')
    out+=f'<g opacity="0">{A("opacity",[0,.34,.40,.68,.72,1],[0,0,1,1,0,0],D,"linear")}{face()}</g>'
    dx,dy=logos.ring_dot_pos()
    def mv(r0,r1): return A("cx",kt,[dx,dx,DOT[0],DOT[0],dx,dx],D)+A("cy",kt,[dy,dy,DOT[1],DOT[1],dy,dy],D)+A("r",kt,[r0,r0,r1,r1,r0,r0],D)
    out+=f'<circle cx="{dx}" cy="{dy}" r="{R["dr"]+R["ko"]}" fill="{PAPER}">{mv(R["dr"]+R["ko"],0)}</circle>'
    out+=f'<circle cx="{dx}" cy="{dy}" r="{R["dr"]}" fill="{ACC}">{mv(R["dr"],DR)}</circle>'
    return wrap(out,"The Ring logo fills in, its orange point slides down to become the mouth, and Glance opens its eyes")

WORK=[("seal2","Approve","Eyes close, the body tightens into a seal, turns orange, stamps once and draws a check. Calmer and more staged than the first try."),
      ("lanes","Fan out, merge back","One Glance splits into three agents in parallel lanes. Each dot lights when that agent finishes, then they fold back into one."),
      ("diff","Read the diff","Glance becomes a card of diff lines. A bar reads down and flags one line orange."),
      ("intake","Many in, one out","Grey changes slide in from the left while Glance watches. One orange merged change comes out the right."),
      ("to_merge","Glance to Merge","The sprout move, reworked. Glance drops to an orange point, two branches grow, each tip gets reviewed, then they merge back down."),
      ("branches","Branch review","Glance rides the main line. The first branch merges in. The second turns orange and gets sent back.")]
BRAND=[("intro","Intro","Lands, blinks, glances right, then the dot. For app launch and video openers."),
       ("color_states","Color states","Same four faces, now with color: ink, grey dot, orange, green."),
       ("pebble_wakes","Pebble logo wakes up","If the logo is Pebble, Glance is the logo with its eyes open."),
       ("ring_opens","Ring logo opens","If the logo is Ring, it fills in and the orange point becomes the mouth.")]

# ---- Round 4: intros where Ring opens while Glance is still waking ----
def _sleepy_eyes(D, open_at, close_at):
    """Heavy-lidded wake: half open, blink, open, pupils drift from low-centre to the right."""
    o=open_at; c=close_at; out=""
    for ex,ey in g["eyes"]:
        ry=g["ery"]
        kt=[0,o,o+.06,o+.10,o+.13,o+.16,o+.24,c,c+.06,1]
        rv=[0,0,ry*0.32,ry*0.32,ry*0.06,ry*0.55,ry,ry,0,0]
        out+=f'<ellipse cx="{ex}" cy="{ey}" rx="{g["erx"]}" ry="0" fill="{PAPER}">{A("ry",kt,rv,D)}</ellipse>'
        pk=[0,o+.02,o+.05,o+.13,o+.16,o+.28,o+.34,c,c+.03,1]
        out+=(f'<circle cx="{ex}" cy="{ey+3}" r="{g["pr"]}" fill="{INK}" opacity="0">'
              f'{A("opacity",[0,o+.15,o+.17,c,c+.02,1],[0,0,1,1,0,0],D,"linear")}'
              f'{A("cx",pk,[ex,ex,ex,ex,ex,ex-g["pdx"]*.6,ex+g["pdx"],ex+g["pdx"],ex,ex],D)}'
              f'{A("cy",pk,[ey+3,ey+3,ey+3,ey+3,ey+3,ey+g["pdy"],ey+g["pdy"],ey+g["pdy"],ey+3,ey+3],D)}</circle>')
    return out

def _ring_to_body(D, kt):
    R=logos.RING
    RINGO=polar([ellipse_poly(R["cx"],R["cy"],R["ro"],R["ro"])])
    out=f'<path d="{to_d(RINGO)}" fill="{INK}">{A("d",kt,[to_d(RINGO),to_d(RINGO),to_d(PEB),to_d(PEB),to_d(RINGO),to_d(RINGO)],D)}</path>'
    out+=(f'<circle cx="{R["cx"]}" cy="{R["cy"]}" r="{R["ri"]}" fill="{PAPER}">{A("r",kt,[R["ri"],R["ri"],0,0,R["ri"],R["ri"]],D)}'
          f'{A("cy",kt,[R["cy"],R["cy"],52,52,R["cy"],R["cy"]],D)}</circle>')
    return out

def _ring_to_body_fog(D, kt):
    """Same morph, but the Ring stays a flat, crisp logo at the start and end and the
    pebble in the middle is Fog. A flat copy and a fog copy cross-fade while it changes shape."""
    R=logos.RING
    RINGO=polar([ellipse_poly(R["cx"],R["cy"],R["ro"],R["ro"])])
    dA=A("d",kt,[to_d(RINGO),to_d(RINGO),to_d(PEB),to_d(PEB),to_d(RINGO),to_d(RINGO)],D)
    flat=(f'<g>{A("opacity",[0,.18,.30,.78,.88,1],[1,1,0,0,1,1],D)}'
          f'<path d="{to_d(RINGO)}" fill="{INK}">{dA}</path></g>')
    fogg=(f'<g opacity="0">{A("opacity",[0,.12,.20,.82,.92,1],[0,0,1,1,0,0],D)}'
          + FOG(f'<path d="{to_d(RINGO)}" fill="{INK}">{dA}</path>',cx=50,cy=52) + '</g>')
    hole=(f'<circle cx="{R["cx"]}" cy="{R["cy"]}" r="{R["ri"]}" fill="{PAPER}">{A("r",kt,[R["ri"],R["ri"],0,0,R["ri"],R["ri"]],D)}'
          f'{A("cy",kt,[R["cy"],R["cy"],52,52,R["cy"],R["cy"]],D)}</circle>')
    return fogg+flat+hole

def _point(D, kt, extra_r=None):
    R=logos.RING; dx,dy=logos.ring_dot_pos()
    def mv(r0,r1): return A("cx",kt,[dx,dx,DOT[0],DOT[0],dx,dx],D)+A("cy",kt,[dy,dy,DOT[1],DOT[1],dy,dy],D)+A("r",kt,[r0,r0,r1,r1,r0,r0],D)
    return (f'<circle cx="{dx}" cy="{dy}" r="{R["dr"]+R["ko"]}" fill="{PAPER}">{mv(R["dr"]+R["ko"],0)}</circle>'
            f'<circle cx="{dx}" cy="{dy}" r="{R["dr"]}" fill="{ACC}">{mv(R["dr"],DR)}</circle>')

def intro_wake():
    """Ring holds, softens into Glance while Glance is still half asleep, stretches, then looks right."""
    D="7s"; kt=[0,.12,.32,.78,.92,1]
    body=_ring_to_body_fog(D,kt)
    stretch=T("scale",[0,.30,.38,.46,.78,1],["1 1","1 1","0.97 1.05","1 1","1 1","1 1"],D)
    inner=about(50,89,stretch,body+_sleepy_eyes(D,.30,.80))
    dot_kt=[0,.40,.52,.78,.90,1]
    return wrap(inner+_point(D,dot_kt),"The Ring logo softens into Glance, which opens heavy eyes, blinks, stretches, then looks right as the orange point drops into place")

def intro_draw():
    """The ring draws itself from the orange point, then wakes."""
    D="8s"; R=logos.RING; rm=(R["ro"]+R["ri"])/2; w=R["ro"]-R["ri"]
    a0=math.radians(R["a"]); sx,sy=R["cx"]+rm*math.cos(a0),R["cy"]+rm*math.sin(a0)
    circ=2*math.pi*rm
    ring_d=f"M{sx:.2f} {sy:.2f} A{rm} {rm} 0 1 1 {R['cx']+rm*math.cos(a0-0.0001):.3f} {R['cy']+rm*math.sin(a0-0.0001):.3f}"
    stroke=(f'<path d="{ring_d}" stroke="{INK}" stroke-width="{w}" fill="none" stroke-dasharray="{circ:.1f} {circ+2:.1f}" stroke-dashoffset="{circ:.1f}">'
            f'{A("stroke-dashoffset",[0,.06,.24,1],[round(circ,1),round(circ,1),0,0],D)}{A("opacity",[0,.24,.25,.96,1],[1,1,0,0,1],D,"linear")}</path>')
    kt=[0,.30,.46,.80,.92,1]
    body=f'<g opacity="0">{A("opacity",[0,.24,.25,.94,.96,1],[0,0,1,1,0,0],D,"linear")}{_ring_to_body(D,kt)}</g>'
    inner=about(50,89,T("scale",[0,.44,.50,.56,1],["1 1","1 1","0.98 1.04","1 1","1 1"],D),body+_sleepy_eyes(D,.44,.82))
    dx,dy=logos.ring_dot_pos()
    K=R["dr"]+R["ko"]; mk=[0,.50,.62,.80,.92,1]
    mv=A("cx",mk,[dx,dx,DOT[0],DOT[0],dx,dx],D)+A("cy",mk,[dy,dy,DOT[1],DOT[1],dy,dy],D)
    pop=(f'<g opacity="0">{A("opacity",[0,.02,.03,.94,.96,1],[0,0,1,1,0,0],D,"linear")}'
         f'<circle cx="{dx}" cy="{dy}" r="0" fill="{PAPER}">{A("r",[0,.02,.06,.50,.60,.91,.94,1],[0,0,K,K,0,0,K,K],D)}{mv}</circle>'
         f'<circle cx="{dx}" cy="{dy}" r="0" fill="{ACC}">{A("r",[0,.02,.06,.50,.62,.80,.92,1],[0,0,R["dr"],R["dr"],DR,DR,R["dr"],R["dr"]],D)}{mv}</circle></g>')
    return wrap(stroke+inner+pop,"The orange point appears, the ring draws itself around from it, then the ring softens into Glance, which wakes slowly")

def intro_peek():
    """Glance is still asleep inside the ring: the hole blinks like one sleepy eye, then opens into two."""
    D="7s"; R=logos.RING; kt=[0,.40,.56,.80,.92,1]
    RINGO=polar([ellipse_poly(R["cx"],R["cy"],R["ro"],R["ro"])])
    body=f'<path d="{to_d(RINGO)}" fill="{INK}">{A("d",kt,[to_d(RINGO),to_d(RINGO),to_d(PEB),to_d(PEB),to_d(RINGO),to_d(RINGO)],D)}</path>'
    ri=R["ri"]
    lid=(f'<ellipse cx="50" cy="50" rx="{ri}" ry="{ri}" fill="{PAPER}">'
         f'{A("ry",[0,.12,.20,.25,.30,.38,.48,.80,.92,1],[ri,ri,2.5,ri*.55,2.5,ri*.35,0,0,ri,ri],D)}'
         f'{A("rx",[0,.38,.48,.80,.92,1],[ri,ri,0,0,ri,ri],D)}</ellipse>')
    inner=about(50,89,T("scale",[0,.56,.62,.68,1],["1 1","1 1","0.97 1.05","1 1","1 1"],D),body+lid+_sleepy_eyes(D,.50,.82))
    return wrap(inner+_point(D,[0,.58,.68,.80,.90,1]),"The hole in the Ring blinks like one sleepy eye, then the ring softens into Glance and two eyes open")
