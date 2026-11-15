import math
INK="#17140F"; PAPER="#F4F2EC"; ACC="#FF5A1F"; GRAPH="#1C1A17"

def body_path(cx=50, cy=53, a=42, b=36, n_top=2.2, n_bot=2.6, egg=0.04, N=72):
    pts=[]
    for i in range(N):
        t=2*math.pi*i/N
        c,s=math.cos(t),math.sin(t)
        n = n_bot if s>0 else n_top
        x=a*math.copysign(abs(c)**(2/n),c); y=b*math.copysign(abs(s)**(2/n),s)
        if y<0: x*=1-egg*(-y/b)
        pts.append((cx+x,cy+y))
    # Catmull-Rom -> cubic bezier, closed
    d=f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"
    for i in range(N):
        p0,p1,p2,p3=pts[i-1],pts[i],pts[(i+1)%N],pts[(i+2)%N]
        c1=(p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6)
        c2=(p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6)
        d+=f" C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}"
    return d+"Z"

# geometry for the full mark (>=48px) and the small cut (<=32px)
FULL=dict(body=dict(), eyes=[(40,50),(63.5,50)], erx=8.6, ery=10.4, pr=5.0, pdx=3.5, pdy=1.4, dot=(58.5,72), dr=4.0)
SMALL=dict(body=dict(a=46,b=41,cy=52), eyes=[(37,48),(65,48)], erx=11.5, ery=13.5, pr=7.4, pdx=4.0, pdy=1.6, dot=(58,75), dr=6.0)

def eyes(g, state, white, pupil):
    out=[]
    for (ex,ey) in g["eyes"]:
        if state=="reviewing":
            out.append(f'<ellipse cx="{ex}" cy="{ey}" rx="{g["erx"]}" ry="{g["ery"]}" fill="{white}"/>')
            out.append(f'<circle cx="{ex+g["pdx"]:.2f}" cy="{ey+g["pdy"]:.2f}" r="{g["pr"]}" fill="{pupil}"/>')
        elif state=="approved":  # happy closed eyes
            w=g["erx"]*0.95; sw=g["erx"]*0.55
            out.append(f'<path d="M{ex-w:.2f} {ey+2.5:.2f} Q{ex:.2f} {ey-9:.2f} {ex+w:.2f} {ey+2.5:.2f}" stroke="{white}" stroke-width="{sw:.2f}" fill="none" stroke-linecap="round"/>')
        elif state=="working":  # blink
            w=g["erx"]*0.95; sw=g["erx"]*0.5
            out.append(f'<path d="M{ex-w:.2f} {ey+2:.2f} H{ex+w:.2f}" stroke="{white}" stroke-width="{sw:.2f}" stroke-linecap="round"/>')
        elif state=="sentback":  # flat lids, looking at you
            rx,ry=g["erx"],g["ery"]
            top=ey-ry*0.05
            out.append(f'<path d="M{ex-rx:.2f} {top:.2f} H{ex+rx:.2f} A{rx} {ry} 0 0 1 {ex-rx:.2f} {top:.2f}Z" fill="{white}"/>')
            out.append(f'<circle cx="{ex:.2f}" cy="{ey+ry*0.38:.2f}" r="{g["pr"]*0.92:.2f}" fill="{pupil}"/>')
    return "".join(out)

def mark_inner(size="full", state="reviewing", theme="light"):
    g=FULL if size=="full" else SMALL
    if theme=="light": body, white, pupil = INK, PAPER, INK
    else:              body, white, pupil = PAPER, GRAPH, PAPER
    return (f'<path d="{body_path(**g["body"])}" fill="{body}"/>' + eyes(g,state,white,pupil) +
            f'<circle cx="{g["dot"][0]}" cy="{g["dot"][1]}" r="{g["dr"]}" fill="{ACC}"/>')

def mark_vars(size="full", state="reviewing"):
    g=FULL if size=="full" else SMALL
    return (f'<path d="{body_path(**g["body"])}" fill="var(--g-body)"/>' + eyes(g,state,"var(--g-eye)","var(--g-pupil)") +
            f'<circle cx="{g["dot"][0]}" cy="{g["dot"][1]}" r="{g["dr"]}" fill="var(--g-dot)"/>')

def svg(inner, size=None, extra=""):
    sz=f' width="{size}" height="{size}"' if size else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"{sz}{extra}>{inner}</svg>'

def icon(theme="light", size="full", pad_scale=6.6):
    bg = PAPER if theme=="light" else GRAPH
    off=(1024-100*pad_scale)/2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="230" fill="{bg}"/>'
            f'<g transform="translate({off:.1f} {off+8:.1f}) scale({pad_scale})">{mark_inner(size,"reviewing",theme)}</g></svg>')
