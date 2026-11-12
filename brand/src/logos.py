"""Primary logo options (modernist), each meant to sit beside Glance.
All on a 100x100 viewBox. Colors come from CSS vars so one drawing serves light and dark:
  --l-ink (main shape), --l-acc (orange), --l-bg (knockout, = the surface colour)."""
import math
from glance import body_path

def pebble():
    # Glance with its eyes shut: the silhouette and the orange dot. The pet grows out of the logo.
    return (f'<path d="{body_path()}" fill="var(--l-ink)"/>'
            f'<circle cx="59" cy="71.5" r="7" fill="var(--l-acc)"/>')

RING=dict(cx=50, cy=50, ro=40, ri=22, a=-45, dr=7.4, ko=3.4)
def ring_dot_pos(R=RING, a=None):
    a=math.radians(R["a"] if a is None else a); rm=(R["ro"]+R["ri"])/2
    return R["cx"]+rm*math.cos(a), R["cy"]+rm*math.sin(a)

def ring(a=None):
    # A heavy lowercase o with an orange review point set into its shoulder.
    R=RING; dx,dy=ring_dot_pos(R,a)
    return (f'<path fill-rule="evenodd" fill="var(--l-ink)" d="M{R["cx"]-R["ro"]} {R["cy"]} a{R["ro"]} {R["ro"]} 0 1 0 {2*R["ro"]} 0 a{R["ro"]} {R["ro"]} 0 1 0 {-2*R["ro"]} 0Z '
            f'M{R["cx"]-R["ri"]} {R["cy"]} a{R["ri"]} {R["ri"]} 0 1 0 {2*R["ri"]} 0 a{R["ri"]} {R["ri"]} 0 1 0 {-2*R["ri"]} 0Z"/>'
            f'<circle cx="{dx:.2f}" cy="{dy:.2f}" r="{R["dr"]+R["ko"]}" fill="var(--l-bg)"/>'
            f'<circle cx="{dx:.2f}" cy="{dy:.2f}" r="{R["dr"]}" fill="var(--l-acc)"/>')

def merge():
    # Two lanes of work joining into one, ending on the orange point.
    s='stroke="var(--l-ink)" stroke-width="15" fill="none" stroke-linecap="round" stroke-linejoin="round"'
    return (f'<path d="M27 15 V27 C27 47 50 43 50 63 M73 15 V27 C73 47 50 43 50 63 V64" {s}/>'
            f'<circle cx="50" cy="83" r="8.6" fill="var(--l-acc)"/>')

LOGOS=[("pebble","Pebble",pebble,
        "Glance with its eyes shut. The logo and the pet are the same shape, so the brand mark wakes up into the agent.",
        "Closest tie to Glance. As a logo it’s a soft blob, so it needs the wordmark next to it at first."),
       ("ring","Ring",ring,
        "A heavy lowercase o with an orange review point set into its shoulder. Strict geometry, like Cursor or Codex.",
        "Most “serious software” of the three and the sharpest at 16px. It opens into Glance in one move."),
       ("merge","Merge",merge,
        "Two lanes of agent work joining into one, ending on the orange point. Says the job: many agents, one merge.",
        "Tells the story best, but a fork shape is common in git tools and it can’t morph into Glance cleanly.")]

def svg(inner, cls="lg", label=None):
    a=f' role="img" aria-label="{label}"' if label else ' aria-hidden="true"'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="{cls}"{a}>{inner}</svg>'
