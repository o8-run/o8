"""The loop as the saga: six real o8 steps, drawn on the Ring.
Step 1 sits at the logo's home point (-45deg); each step is 60deg further round.
Done steps are small orange dots in the band, the current step carries the big point, the rest are small paper holes."""
import math, logos
R=logos.RING
STEPS=[  # name, what o8 does, status, issues, glance state, motion
 ("Arrive","Work comes in from any tool.","part","Works today for o8 missions; pull requests from any tool are next (#5816).","working","Many in, one out"),
 ("Review","An independent reviewer reads the real diff.","done","On main: each review is saved with the commit it read (#5825).","reviewing","Read the diff"),
 ("Send back","Findings go back to the agent that wrote it.","done","On main, not released yet (#5828, #5833).","sentback","Branch review"),
 ("Re-review","The fix is checked against those findings.","now","Being built now (#5835).","reviewing","Approve"),
 ("Merge","The approved commit merges, with a receipt.","next","Next (#5817), with merge rules a project sets once (#5822).","approved","Fan out, merge back"),
 ("Learn","Reviewers remember what happened.","later","After merge (#5823).","working",None)]
LABEL={"done":"Works on main","part":"Partly works","now":"Being built","next":"Next","later":"Later"}

def pos(i, r=None):
    a=math.radians(-45+60*i); rm=(R["ro"]+R["ri"])/2 if r is None else r
    return R["cx"]+rm*math.cos(a), R["cy"]+rm*math.sin(a)

def dial(cur, status=True):
    out=[f'<path fill-rule="evenodd" fill="var(--l-ink)" d="M{R["cx"]-R["ro"]} {R["cy"]} a{R["ro"]} {R["ro"]} 0 1 0 {2*R["ro"]} 0 a{R["ro"]} {R["ro"]} 0 1 0 {-2*R["ro"]} 0Z M{R["cx"]-R["ri"]} {R["cy"]} a{R["ri"]} {R["ri"]} 0 1 0 {2*R["ri"]} 0 a{R["ri"]} {R["ri"]} 0 1 0 {-2*R["ri"]} 0Z"/>']
    for i,st in enumerate(STEPS):
        x,y=pos(i)
        if i==cur:
            out.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{R["dr"]+R["ko"]}" fill="var(--l-bg)"/><circle cx="{x:.2f}" cy="{y:.2f}" r="{R["dr"]}" fill="var(--l-acc)"/>')
        elif not status: continue
        elif st[2] in ("done","part"):
            out.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="3.2" fill="var(--l-acc)"/>')
        else:
            out.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="2.6" fill="var(--l-bg)"/>')
    return logos.svg("".join(out),"mk")

def cards(m):
    h=[]
    for i,(n,does,st,where,face,mot) in enumerate(STEPS):
        mo=f'<span class="st-mo">Motion: {mot}</span>' if mot else '<span class="st-mo">Motion: to make</span>'
        h.append(f'<figure class="step st-{st}"><span class="era-ring light">{dial(i, False)}</span>'
                 f'<figcaption><small>Step {i+1} · {LABEL[st]}</small><b><span class="avatar light">{m("small",face)}</span>{n}</b>'
                 f'<span class="st-does">{does}</span><span class="st-where">{where}</span>{mo}</figcaption></figure>')
    return "".join(h)

def today():
    cur=[i for i,st in enumerate(STEPS) if st[2]=="now"][0]
    return dial(cur)
