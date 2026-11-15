"""Exports the locked motions (and the open Glance to Merge) from studies.py to brand/motion/.
Run from brand/src:  python3 -I motions.py "$PWD"   (needs no extra packages)"""
import sys, os; SRC=sys.argv[1]; sys.path.insert(0, SRC)
import studies
OUT=os.path.join(SRC, "..", "motion")
MOTIONS={  # file name: studies function
    "intro-wake": "intro_wake", "approve": "seal2", "fan-out": "lanes", "read-the-diff": "diff",
    "many-in-one-out": "intake", "branch-review": "branches", "color-states": "color_states",
    "glance-to-merge-OPEN": "to_merge",  # not locked yet
}
for name, fn in MOTIONS.items():
    svg = getattr(studies, fn)().replace('<svg class="morph" ', '<svg ', 1)
    open(os.path.join(OUT, name + ".svg"), "w").write(svg)
print("wrote", len(MOTIONS), "motions to", os.path.normpath(OUT))
