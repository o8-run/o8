import math
# Each mark: SVG inner markup on a 100x100 box using placeholders INK, PAPER, ACC.
def seal_path(cx=50, cy=50, r=40, bumps=18, amp=3.2):
    pts=[]
    n=bumps*8
    for i in range(n+1):
        a=2*math.pi*i/n - math.pi/2
        rr=r+amp*math.cos(bumps*a)
        pts.append((cx+rr*math.cos(a), cy+rr*math.sin(a)))
    return "M"+" L".join(f"{x:.2f} {y:.2f}" for x,y in pts)+"Z"

MARKS = {
 "otter": '''<path d="M31 62 L7 57 M31 67 L8 70 M69 62 L93 57 M69 67 L92 70" stroke="INK" stroke-width="2.2" stroke-linecap="round"/>
<circle cx="19" cy="38" r="7.5" fill="INK"/><circle cx="81" cy="38" r="7.5" fill="INK"/>
<ellipse cx="50" cy="55" rx="37" ry="29" fill="INK"/>
<path d="M22 66 C24 52 38 50 50 55 C62 50 76 52 78 66 C76 78 62 83 50 83 C38 83 24 78 22 66Z" fill="PAPER"/>
<circle cx="35" cy="46" r="4.4" fill="PAPER"/><circle cx="65" cy="46" r="4.4" fill="PAPER"/>
<path d="M42.5 58 Q50 54.5 57.5 58 Q56 64 50 65 Q44 64 42.5 58Z" fill="ACC"/>
<path d="M50 65 V69 M44 71 Q50 75 56 71" stroke="INK" stroke-width="2.2" fill="none" stroke-linecap="round"/>
<circle cx="37" cy="67" r="1.4" fill="INK"/><circle cx="33" cy="71" r="1.4" fill="INK"/><circle cx="63" cy="67" r="1.4" fill="INK"/><circle cx="67" cy="71" r="1.4" fill="INK"/>''',
 "glance": '''<path d="M50 11 C77 11 91 29 91 54 C91 77 75 91 50 91 C25 91 9 77 9 54 C9 29 23 11 50 11Z" fill="INK"/>
<ellipse cx="43" cy="49" rx="9" ry="10.5" fill="PAPER"/><ellipse cx="68" cy="49" rx="9" ry="10.5" fill="PAPER"/>
<circle cx="47.5" cy="51.5" r="4.6" fill="INK"/><circle cx="72.5" cy="51.5" r="4.6" fill="INK"/>
<circle cx="70" cy="74" r="4.2" fill="ACC"/>''',
 "seal": f'''<path d="{seal_path()}" fill="ACC"/>
<circle cx="50" cy="50" r="30" fill="none" stroke="PAPER" stroke-width="1.6" stroke-dasharray="2.2 3.2"/>
<path d="M34.5 51.5 L45 62 L66.5 39.5" stroke="PAPER" stroke-width="7.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>''',
 "sprout": '''<path d="M50 90 V48" stroke="INK" stroke-width="7.5" stroke-linecap="round"/>
<path d="M50 66 C34 67 15 58 10 32 C33 31 48 44 50 66Z" fill="INK"/>
<path d="M50 54 C50 30 64 12 91 9 C92 36 76 53 50 54Z" fill="ACC"/>''',
}

def svg(name, ink="#17140F", paper="#F4F2EC", acc="#FF5A1F", size=None, extra=""):
    body = MARKS[name].replace("INK", ink).replace("PAPER", paper).replace("ACC", acc)
    sz = f' width="{size}" height="{size}"' if size else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"{sz}{extra}>{body}</svg>'

def svg_vars(name, extra=''):
    return svg(name, "var(--m-ink)", "var(--m-paper)", "var(--m-acc)", extra=extra)
