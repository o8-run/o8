"""Glance without a hard body: the silhouette is fog that fades outward to nothing; eyes and orange dot stay crisp.
The fog is n copies of the body (one <path>, reused with <use>), each slightly larger, with per-layer opacity
solved so the stacked density follows a smooth curve: full inside s0, zero at s1. No blur filter, so it
renders identically in browsers, native apps and image exports. Colors via --g-body/--g-eye/--g-pupil/--g-dot."""
from glance import body_path, eyes, FULL, SMALL

STYLES={  # s0 dense-to scale, s1 gone-by scale, peak density, curve
 "fog":  dict(s0=0.70, s1=1.22, peak=1.00, curve="smooth", n=56),
 "mist": dict(s0=0.40, s1=1.28, peak=0.82, curve="smooth", n=56),
 "core": dict(s0=0.90, s1=1.42, peak=1.00, curve="tail",   n=56),
 "tight":dict(s0=0.86, s1=1.10, peak=1.00, curve="smooth", n=28),
 "hair": dict(s0=0.93, s1=1.07, peak=1.00, curve="smooth", n=20),  # 16-20px: fade under a pixel
}
TIER=[(48,"fog","full"),(24,"tight","small"),(0,"hair","small")]  # min px -> style, cut
def for_px(px):
    for lo,st,sz in TIER:
        if px>=lo: return st,sz
NAMES={"fog":"Fog","mist":"Mist","core":"Core"}
_uid=[0]

def _density(u, curve):
    u=min(max(u,0.0),1.0)
    if curve=="tail": return (1-u)**2.4
    return 1-(u*u*(3-2*u))

def body_layers(style, size="full", uid=None):
    if uid is None: _uid[0]+=1; uid=f"gf{_uid[0]}"
    g=FULL if size=="full" else SMALL; st=STYLES[style]; cx,cy=50,53; n=st["n"]
    d=body_path(**g["body"])
    out=[f'<defs><path id="{uid}" d="{d}"/></defs><g fill="var(--g-body)">']
    cov=0.0
    for k in range(n):                       # outermost first
        s=st["s1"]-(st["s1"]-st["s0"])*(k/(n-1))
        u=(s-st["s0"])/(st["s1"]-st["s0"])
        target=st["peak"]*_density(u,st["curve"])
        if target<=cov+1e-4: continue
        a=1-(1-target)/(1-cov) if cov<1 else 0
        cov=target
        out.append(f'<use href="#{uid}" fill-opacity="{a:.4f}" transform="translate({cx} {cy}) scale({s:.4f}) translate({-cx} {-cy})"/>')
    out.append('</g>')
    return "".join(out)

def uses(href, style="fog", cx=50, cy=53):
    """Fog layers for any already-defined body element (it can be animated: <use> follows it)."""
    st=STYLES[style]; n=st["n"]; out=[]; cov=0.0
    for k in range(n):
        s=st["s1"]-(st["s1"]-st["s0"])*(k/(n-1))
        u=(s-st["s0"])/(st["s1"]-st["s0"])
        target=st["peak"]*_density(u,st["curve"])
        if target<=cov+1e-4: continue
        a=1-(1-target)/(1-cov) if cov<1 else 0
        cov=target
        out.append(f'<use href="#{href}" fill-opacity="{a:.4f}" transform="translate({cx} {cy}) scale({s:.4f}) translate({-cx} {-cy})"/>')
    return "".join(out)

DEFAULT=["fog"]  # style FOG() uses when none is given; set to "tight" to build small (composer) copies
def FOG(el, style=None, cx=50, cy=53):
    """Turn one body element string (<path ...>...</path> or <path .../>) into fog. Keeps its animations."""
    style=style or DEFAULT[0]
    _uid[0]+=1; uid=f"gb{_uid[0]}"
    el=el.replace("<path ",f'<path id="{uid}" ',1)
    return f'<defs>{el}</defs>{uses(uid,style,cx,cy)}'

def inner(style="fog", size="full", state="reviewing", uid=None):
    g=FULL if size=="full" else SMALL
    return (body_layers(style,size,uid)+eyes(g,state,"var(--g-eye)","var(--g-pupil)")+
            f'<circle cx="{g["dot"][0]}" cy="{g["dot"][1]}" r="{g["dr"]}" fill="var(--g-dot)"/>')

VB="-8 -8 116 116"  # fog fades to zero by 1.22x the body, so 8 units of margin is enough
VBS={"tight":"-3 -3 106 106","hair":"-3 -3 106 106"}  # small cuts: less padding so the face stays big
def svg(style="fog", size="full", state="reviewing", cls="mk", uid=None):
    return f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="{VBS.get(style,VB)}" class="{cls}" aria-hidden="true">{inner(style,size,state,uid)}</svg>'
