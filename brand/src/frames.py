import sys, re, xml.etree.ElementTree as ET
sys.path.insert(0, sys.argv[1])
import cairosvg, working, json, os, time
NS="{http://www.w3.org/2000/svg}"
num=re.compile(r'-?\d+\.?\d*(?:e-?\d+)?')
def bez(x1,y1,x2,y2,t):
    lo,hi=0.0,1.0
    for _ in range(40):
        m=(lo+hi)/2; mt=1-m; x=3*mt*mt*m*x1+3*mt*m*m*x2+m**3
        if x<t: lo=m
        else: hi=m
    m=(lo+hi)/2; mt=1-m; return 3*mt*mt*m*y1+3*mt*m*m*y2+m**3
def interp(a,b,u):
    if a.startswith('#') and b.startswith('#'):
        ca=[int(a[i:i+2],16) for i in (1,3,5)]; cb=[int(b[i:i+2],16) for i in (1,3,5)]
        return '#'+''.join(f'{round(x+(y-x)*u):02x}' for x,y in zip(ca,cb))
    na=num.findall(a); nb=num.findall(b)
    if len(na)!=len(nb) or not na: return a if u<0.5 else b
    it=iter([float(x)+(float(y)-float(x))*u for x,y in zip(na,nb)])
    return num.sub(lambda m: f'{next(it):.3f}', a)
def val(an,t):
    dur=float(an.get('dur').rstrip('s')); f=(t%dur)/dur
    kt=[float(x) for x in an.get('keyTimes').split(';')]; vals=an.get('values').split(';')
    mode=an.get('calcMode','linear')
    for i in range(len(kt)-1):
        if kt[i]<=f<=kt[i+1]: break
    if mode=='discrete':
        j=max(k for k in range(len(kt)) if kt[k]<=f); return vals[j]
    span=kt[i+1]-kt[i]; u=0 if span==0 else (f-kt[i])/span
    if mode=='spline':
        x1,y1,x2,y2=map(float,an.get('keySplines').split(';')[i].split()); u=bez(x1,y1,x2,y2,u)
    return interp(vals[i],vals[i+1],u)
def frame(svgtxt,t):
    root=ET.fromstring(svgtxt); parent={c:p for p in root.iter() for c in p}
    for an in list(root.iter()):
        tag=an.tag.replace(NS,'')
        if tag in('animate','animateTransform'):
            p=parent[an]; v=val(an,t)
            if tag=='animate': p.set(an.get('attributeName'),v)
            else: p.set('transform',f"{an.get('type')}({v})")
    for p in list(root.iter()):
        for c in list(p):
            if c.tag.replace(NS,'') in('animate','animateTransform'): p.remove(c)
    return ET.tostring(root,encoding='unicode')

OUT=sys.argv[2]; FPS=int(sys.argv[3]); PX=int(sys.argv[4]); STYLE=sys.argv[5]
t0=time.time(); index=[]
for st in working.build(STYLE):
    d=os.path.join(OUT,st["key"]); os.makedirs(d,exist_ok=True)
    n=int(round(st["dur"]*FPS))
    for i in range(n):
        cairosvg.svg2png(bytestring=frame(st["svg"],i/FPS).encode(), write_to=f"{d}/{i:03d}.png", output_width=PX, output_height=PX)
    index.append(dict(key=st["key"],frames=n,fps=FPS,px=PX,loop_seconds=st["dur"]))
json.dump(index,open(os.path.join(OUT,"frames.json"),"w"),indent=2)
print("done",round(time.time()-t0,1),"s")
