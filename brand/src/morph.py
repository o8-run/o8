import math, sys
from glance import FULL, eyes, INK, PAPER, ACC
sys.path.insert(0, __file__.rsplit('/',2)[0]+'/gen')
from marks import MARKS

C=(50.0,52.0); N=144
def pebble_poly(cx=50, cy=53, a=42, b=36, n_top=2.2, n_bot=2.6, egg=0.04, M=360):
    pts=[]
    for i in range(M):
        t=2*math.pi*i/M; c,s=math.cos(t),math.sin(t); n=n_bot if s>0 else n_top
        x=a*math.copysign(abs(c)**(2/n),c); y=b*math.copysign(abs(s)**(2/n),s)
        if y<0: x*=1-egg*(-y/b)
        pts.append((cx+x,cy+y))
    return pts
def ellipse_poly(cx,cy,rx,ry,M=240): return [(cx+rx*math.cos(2*math.pi*i/M),cy+ry*math.sin(2*math.pi*i/M)) for i in range(M)]
def seal_poly(cx=50,cy=52,r=39,bumps=18,amp=3.2,M=720):
    pts=[]
    for i in range(M):
        a=2*math.pi*i/M-math.pi/2; rr=r+amp*math.cos(bumps*a)
        pts.append((cx+rr*math.cos(a),cy+rr*math.sin(a)))
    return pts
def ray(polys, th):
    dx,dy=math.cos(th),math.sin(th); best=0
    for poly in polys:
        for i in range(len(poly)):
            (x1,y1),(x2,y2)=poly[i],poly[(i+1)%len(poly)]
            ex,ey=x2-x1,y2-y1; den=dx*ey-dy*ex
            if abs(den)<1e-12: continue
            t=((x1-C[0])*ey-(y1-C[1])*ex)/den; u=((x1-C[0])*dy-(y1-C[1])*dx)/den
            if t>0 and 0<=u<=1: best=max(best,t)
    return best
def polar(polys):
    return [(C[0]+ray(polys,th)*math.cos(th), C[1]+ray(polys,th)*math.sin(th)) for th in [-math.pi/2+2*math.pi*i/N for i in range(N)]]
def to_d(pts):
    n=len(pts); d=f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"
    for i in range(n):
        p0,p1,p2,p3=pts[i-1],pts[i],pts[(i+1)%n],pts[(i+2)%n]
        c1=(p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6); c2=(p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6)
        d+=f" C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}"
    return d+"Z"

PEB=polar([pebble_poly()])
SEAL=polar([seal_poly()])
OTTER=polar([ellipse_poly(50,55,37,29),ellipse_poly(19,38,7.5,7.5),ellipse_poly(81,38,7.5,7.5)])
SEED=[(50+0.27*(x-50),86+0.27*(y-52)) for x,y in PEB]

DUR="6.4s"
KT6="0;0.16;0.36;0.70;0.90;1"; EASE5="0 0 1 1;0.65 0 0.2 1;0 0 1 1;0.65 0 0.2 1;0 0 1 1"
def an(attr, a, b, extra=""):
    return f'<animate attributeName="{attr}" dur="{DUR}" repeatCount="indefinite" calcMode="spline" keyTimes="{KT6}" keySplines="{EASE5}" values="{a};{a};{b};{b};{a};{a}"{extra}/>'
def fade(out=True):
    if out: v,kt="1;1;0;0;1;1","0;0.16;0.22;0.86;0.92;1"
    else:   v,kt="0;0;1;1;0;0","0;0.30;0.38;0.70;0.76;1"
    return f'<animate attributeName="opacity" dur="{DUR}" repeatCount="indefinite" keyTimes="{kt}" values="{v}"/>'

def glance_face(): 
    g=FULL
    return eyes(g,"reviewing",PAPER,INK)+f'<circle cx="{g["dot"][0]}" cy="{g["dot"][1]}" r="{g["dr"]}" fill="{ACC}"/>'

def wrap(inner, label):
    return f'<svg class="morph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="{label}">{inner}</svg>'

def to_otter():
    ol=MARKS["otter"].replace("INK",INK).replace("PAPER",PAPER).replace("ACC",ACC).split("\n")
    feats="".join(ol[i] for i in [0,3,4,5,6,7])
    body=f'<path d="{to_d(PEB)}" fill="{INK}">{an("d",to_d(PEB),to_d(OTTER))}</path>'
    return wrap(f'<g opacity="0">{fade(False)}{ol[0]}</g>'+body+f'<g>{fade(True)}{glance_face()}</g><g opacity="0">{fade(False)}{"".join(ol[i] for i in [3,4,5,6,7])}</g>', "Glance morphing into the otter and back")

def to_seal():
    body=f'<path d="{to_d(PEB)}" fill="{INK}">{an("d",to_d(PEB),to_d(SEAL))}{an("fill",INK,ACC)}</path>'
    ring=f'<g opacity="0">{fade(False)}<circle cx="50" cy="52" r="29.5" fill="none" stroke="{PAPER}" stroke-width="1.6" stroke-dasharray="2.2 3.2"/></g>'
    L=47
    check=(f'<path d="M34.5 53.5 L45 64 L66.5 41.5" stroke="{PAPER}" stroke-width="7.5" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="{L}" stroke-dashoffset="{L}">'
           f'<animate attributeName="stroke-dashoffset" dur="{DUR}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.36;0.48;0.70;0.76;1" keySplines="0 0 1 1;0.5 0 0.2 1;0 0 1 1;0.5 0 1 1;0 0 1 1" values="{L};{L};0;0;{L};{L}"/></path>')
    return wrap(body+f'<g>{fade(True)}{glance_face()}</g>'+ring+check, "Glance stamping into the approval seal and back")

def to_sprout():
    body=f'<path d="{to_d(PEB)}" fill="{INK}">{an("d",to_d(PEB),to_d(SEED))}</path>'
    S=36
    stem=(f'<path d="M50 82 V46" stroke="{INK}" stroke-width="7" stroke-linecap="round" stroke-dasharray="{S}" stroke-dashoffset="{S}">'
          f'<animate attributeName="stroke-dashoffset" dur="{DUR}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.34;0.46;0.70;0.78;1" keySplines="0 0 1 1;0.5 0 0.2 1;0 0 1 1;0.5 0 1 1;0 0 1 1" values="{S};{S};0;0;{S};{S}"/></path>')
    def leaf(d, fill, bx, by, t0, t1):
        return (f'<g transform="translate({bx} {by})"><g transform="scale(0)">'
                f'<animateTransform attributeName="transform" type="scale" dur="{DUR}" repeatCount="indefinite" calcMode="spline" keyTimes="0;{t0};{t1};0.70;0.78;1" keySplines="0 0 1 1;0.3 1.4 0.4 1;0 0 1 1;0.5 0 1 1;0 0 1 1" values="0;0;1;1;0;0"/>'
                f'<g transform="translate({-bx} {-by})"><path d="{d}" fill="{fill}"/></g></g></g>')
    l1=leaf("M50 66 C34 67 15 58 10 32 C33 31 48 44 50 66Z",INK,50,66,0.42,0.52)
    l2=leaf("M50 54 C50 30 64 12 91 9 C92 36 76 53 50 54Z",ACC,50,54,0.46,0.58)
    return wrap(stem+l1+l2+body+f'<g>{fade(True)}{glance_face()}</g>', "Glance shrinking into a seed and growing into the sprout")

def faces():
    from glance import body_path
    g=FULL; D="6s"; out=[]
    specs=[("reviewing","1;0","0;0.25"),("working","0;1;0","0;0.25;0.5"),("sentback","0;1;0","0;0.5;0.75"),("approved","0;1","0;0.75")]
    for st,v,kt in specs:
        out.append(f'<g opacity="{v[0]}"><animate attributeName="opacity" dur="{D}" repeatCount="indefinite" calcMode="discrete" keyTimes="{kt}" values="{v}"/>{eyes(g,st,PAPER,INK)}</g>')
    return wrap(f'<path d="{body_path()}" fill="{INK}"/>'+"".join(out)+f'<circle cx="{g["dot"][0]}" cy="{g["dot"][1]}" r="{g["dr"]}" fill="{ACC}"/>', "Glance cycling through reviewing, working, sent back and approved")

def intro():
    from glance import body_path
    g=FULL; D="4.2s"
    body=(f'<g><animateTransform attributeName="transform" type="translate" dur="{D}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.16;1" keySplines="0.5 0 0.9 0.6;0 0 1 1" values="0 -70;0 0;0 0"/>'
          f'<g transform="translate(50 89)"><g><animateTransform attributeName="transform" type="scale" dur="{D}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.16;0.22;0.30;1" keySplines="0 0 1 1;0.2 0 0.4 1;0.3 0 0.3 1;0 0 1 1" values="0.9 1.12;1 1;1.12 0.86;1 1;1 1"/>'
          f'<g transform="translate(-50 -89)"><path d="{body_path()}" fill="{INK}"/>')
    ey=""
    for (ex,eyy) in g["eyes"]:
        ey+=(f'<ellipse cx="{ex}" cy="{eyy}" rx="{g["erx"]}" ry="{g["ery"]}" fill="{PAPER}">'
             f'<animate attributeName="ry" dur="{D}" repeatCount="indefinite" keyTimes="0;0.30;0.34;0.38;0.42;1" values="0.6;0.6;{g["ery"]};0.8;{g["ery"]};{g["ery"]}"/></ellipse>'
             f'<circle cx="{ex}" cy="{eyy+g["pdy"]}" r="{g["pr"]}" fill="{INK}">'
             f'<animate attributeName="cx" dur="{D}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.48;0.58;1" keySplines="0 0 1 1;0.6 0 0.2 1;0 0 1 1" values="{ex};{ex};{ex+g["pdx"]};{ex+g["pdx"]}"/>'
             f'<animate attributeName="opacity" dur="{D}" repeatCount="indefinite" keyTimes="0;0.31;0.33;1" values="0;0;1;1"/></circle>')
    dot=(f'<circle cx="{g["dot"][0]}" cy="{g["dot"][1]}" r="0" fill="{ACC}"><animate attributeName="r" dur="{D}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.62;0.70;0.74;1" keySplines="0 0 1 1;0.3 0 0.3 1;0.4 0 0.6 1;0 0 1 1" values="0;0;{g["dr"]*1.35};{g["dr"]};{g["dr"]}"/></circle>')
    return wrap(body+ey+dot+'</g></g></g></g>', "Glance landing, blinking, glancing right and the orange dot appearing")
