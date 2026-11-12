"""Builds the o8 Branding v1 asset set: Ring, app icon, favicon, Glance, motions, working indicator.
Run: python3 -I build_v1.py <this dir> <out dir>   (needs cairosvg)"""
import sys, os, json, re, shutil
SRC, OUT = sys.argv[1], sys.argv[2]; sys.path.insert(0, SRC)
import cairosvg, fog, glance, logos, working
INK,PAPER,ACC,GRAPH,GREY,GREEN="#17140F","#F4F2EC","#FF5A1F","#242424","#A8A398","#15803D"
DEEP_EYE="#1C1A17"
def w(rel, s):
    p=os.path.join(OUT,rel); os.makedirs(os.path.dirname(p),exist_ok=True); open(p,"w").write(s); return p
def png(svgtxt, rel, px):
    p=os.path.join(OUT,rel); os.makedirs(os.path.dirname(p),exist_ok=True)
    cairosvg.svg2png(bytestring=svgtxt.encode(), write_to=p, output_width=px, output_height=px)

# ---------- Ring: transparent, the knockout is a real cut (mask), so it sits on any surface ----------
R=logos.RING; dx,dy=logos.ring_dot_pos()
RING_D=(f'M{R["cx"]-R["ro"]} {R["cy"]} a{R["ro"]} {R["ro"]} 0 1 0 {2*R["ro"]} 0 a{R["ro"]} {R["ro"]} 0 1 0 {-2*R["ro"]} 0Z '
        f'M{R["cx"]-R["ri"]} {R["cy"]} a{R["ri"]} {R["ri"]} 0 1 0 {2*R["ri"]} 0 a{R["ri"]} {R["ri"]} 0 1 0 {-2*R["ri"]} 0Z')
def ring_inner(ink, acc, mid="rk"):
    return (f'<defs><mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">'
            f'<rect width="100" height="100" fill="#fff"/><circle cx="{dx:.2f}" cy="{dy:.2f}" r="{R["dr"]+R["ko"]}" fill="#000"/></mask></defs>'
            f'<path fill-rule="evenodd" fill="{ink}" mask="url(#{mid})" d="{RING_D}"/>'
            f'<circle cx="{dx:.2f}" cy="{dy:.2f}" r="{R["dr"]}" fill="{acc}"/>')
def ring_svg(ink, acc, label="o8"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="{label}">{ring_inner(ink,acc)}</svg>'
w("brand/ring/ring-light.svg", ring_svg(INK,ACC))          # for light surfaces
w("brand/ring/ring-dark.svg", ring_svg(PAPER,ACC))         # for dark surfaces
w("brand/ring/ring-mono-ink.svg", ring_svg(INK,INK))       # one-colour print, no orange
w("brand/ring/ring-mono-paper.svg", ring_svg(PAPER,PAPER))
w("brand/ring/ring-currentcolor.svg", ring_svg("currentColor",ACC))  # inline in UI, inherits text colour
for px in (512,1024): png(ring_svg(INK,ACC), f"brand/ring/ring-light-{px}.png", px); png(ring_svg(PAPER,ACC), f"brand/ring/ring-dark-{px}.png", px)
# loop steps: the point moves 60 degrees per step (step 1 = home, -45 deg)
for i in range(6):
    a=-45+60*i; x,y=logos.ring_dot_pos(a=a)
    inner=(f'<defs><mask id="rk" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/>'
           f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{R["dr"]+R["ko"]}" fill="#000"/></mask></defs>'
           f'<path fill-rule="evenodd" fill="{INK}" mask="url(#rk)" d="{RING_D}"/><circle cx="{x:.2f}" cy="{y:.2f}" r="{R["dr"]}" fill="{ACC}"/>')
    w(f"brand/ring/loop/ring-step-{i+1}.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="o8, loop step {i+1}">{inner}</svg>')

# ---------- App icon: flat Ring on a tile. macOS grid: 824px tile inside 1024, radius 185 ----------
def icon_svg(theme, bleed=False):
    bg,ink = (PAPER,INK) if theme=="light" else (GRAPH,PAPER)
    tile = f'<rect width="1024" height="1024" fill="{bg}"/>' if bleed else f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{bg}"/>'
    shadow = '' if bleed else '<rect x="100" y="112" width="824" height="824" rx="185" fill="#000" opacity="0.10"/>'
    k = 5.0 if not bleed else 6.0   # ring is ~ half the tile
    off=512-50*k
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{shadow}{tile}'
            f'<g transform="translate({off} {off}) scale({k})">{ring_inner(ink,ACC,"ik")}</g></svg>')
for th in ("light","dark"):
    s=icon_svg(th); w(f"brand/app-icon/icon-{th}.svg", s)
    sb=icon_svg(th,True); w(f"brand/app-icon/icon-{th}-square.svg", sb)
    png(sb, f"brand/app-icon/icon-{th}-square-1024.png", 1024)
    for base in (16,32,128,256,512):
        png(s, f"brand/app-icon/o8-{th}.iconset/icon_{base}x{base}.png", base)
        png(s, f"brand/app-icon/o8-{th}.iconset/icon_{base}x{base}@2x.png", base*2)
    for px in (32,64,128,256,512,1024): png(s, f"brand/app-icon/png/icon-{th}-{px}.png", px)

# ---------- Favicon: Ring, switches with the browser theme ----------
fav=(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.r{{fill:{INK}}}@media (prefers-color-scheme:dark){{.r{{fill:{PAPER}}}}}</style>'
     + ring_inner("x",ACC).replace('fill="x"','class="r"') + '</svg>')
w("brand/favicon/favicon.svg", fav)
for px in (16,32,48): png(ring_svg(INK,ACC), f"brand/favicon/favicon-{px}.png", px)
png(icon_svg("light",True), "brand/favicon/apple-touch-icon-180.png", 180)

# ---------- Glance: fog tiers x theme, and the four color states ----------
STATE={  # light: body, eye, pupil, dot
 "reviewing":(INK,PAPER,INK,ACC), "working":(INK,PAPER,INK,GREY),
 "sentback":(ACC,PAPER,INK,INK), "approved":(GREEN,PAPER,INK,PAPER)}
DARK={"reviewing":(PAPER,DEEP_EYE,PAPER,ACC),"working":(PAPER,DEEP_EYE,PAPER,GREY),
      "sentback":(ACC,PAPER,INK,INK),"approved":(GREEN,PAPER,INK,PAPER)}
def glance_svg(style,size,state,cols):
    return bake(fog.svg(style,size,state,cls="glance"), cols)
def bake(s, cols):  # literal colours: GPUI's SVG renderer (resvg) and some tools ignore CSS variables
    for k,v in zip(("body","eye","pupil","dot"),cols): s=s.replace(f"var(--g-{k})",v)
    assert "var(" not in s; return s
CUT={"fog":"full","mist":"full","tight":"small","hair":"small"}
for style,size in CUT.items():
    w(f"brand/glance/glance-{style}-light.svg", glance_svg(style,size,"reviewing",STATE["reviewing"]))
    w(f"brand/glance/glance-{style}-dark.svg", glance_svg(style,size,"reviewing",DARK["reviewing"]))
for st in STATE:
    for style in ("fog","tight"):
        w(f"brand/glance/states/glance-{st}-{style}-light.svg", glance_svg(style,CUT[style],st,STATE[st]))
        w(f"brand/glance/states/glance-{st}-{style}-dark.svg", glance_svg(style,CUT[style],st,DARK[st]))
# flat fallback (where layered SVG can't render)
for st in STATE:
    w(f"brand/glance/flat/glance-{st}-flat.svg", bake(glance.svg(glance.mark_vars("full",st)),STATE[st]))
    w(f"brand/glance/flat/glance-{st}-flat-small.svg", bake(glance.svg(glance.mark_vars("small",st)),STATE[st]))

# ---------- Motions (locked) ----------
MOT="/mnt/project-files/o8-brand/glance/motion"
for src,dst in [("fog-approve","approve"),("fog-fan-out","fan-out"),("fog-read-the-diff","read-the-diff"),
                ("fog-many-in-one-out","many-in-one-out"),("fog-branch-review","branch-review"),
                ("fog-color-states","color-states"),("fog-intro-wake","intro-wake")]:
    shutil.copy(f"{MOT}/{src}.svg", os.path.join(OUT,"brand/motion",f"{dst}.svg") if os.makedirs(os.path.join(OUT,"brand/motion"),exist_ok=True) is None else None)

# ---------- Working indicator v1 ----------
meta=[]
for style,folder in (("tight","composer"),("fog","stage")):
    for st in working.build(style):
        w(f"brand/working/{folder}/{st['key']}.svg", st["svg"])
        if folder=="composer":
            meta.append(dict(key=st["key"],label=st["label"],example_line=st["line"],
                             motion=dict(thinking="thinking (new)",arrive="many-in-one-out",review="read-the-diff",
                                         sendback="sendback (new)",waiting="fan-out",rereview="branch-review",
                                         merging="glance-to-merge (open)",approved="approve")[st["key"]],
                             loop_seconds=st["dur"]))
w("brand/working/states.json", json.dumps(dict(
    version="v1", crossfade_ms=300, switch_rule="switch only at the end of the current loop",
    composer=dict(size_px=40, fog="tight", file="composer/<key>.svg"), stage=dict(size_px=96, fog="fog", file="stage/<key>.svg"),
    timer="m:ss · esc to stop", states=meta), indent=2))
# grep checks
print("files:", sum(len(f) for _,_,f in os.walk(OUT)))
