# Recents review round 1

`sidebar_recents_twelfth_keyboard_row_survives_live_cutoff` opens the real shell,
uses F8/Home and eleven Down presses to focus the twelfth row of a collapsed
Today group, then writes a newer message for an undisclosed thread through
`POST /api/v2/chat-history`. The production discovery adapter and fixture socket
deliver the update. Enter must open the original keyboard-focused thread.
The test also checks disclosure of the thirteenth row and its viewport bounds.
No sidebar state is assigned by the test.

Red on the previous Recents head (`96c92224b`, including the header keyboard fix):

```text
assertion `left == right` failed: Enter after a live cutoff must open the thread the user keyboard-focused; choice after update: "thoughts-sidebar-0015"
  left: "thoughts-sidebar-0015"
 right: "thoughts-sidebar-0010"
test result: FAILED. 0 passed; 1 failed; 172 filtered out
```

Green after preserving the choice ID, expanding its group when it crosses the
cutoff, and scrolling that same choice into view:

```text
sidebar_recents_twelfth_keyboard_row_survives_live_cutoff ... ok
test result: ok. 1 passed; 0 failed; 172 filtered out
```

## Measurement wait

The earlier HTTP/paint timeout remains a failed sample, not a speed receipt.
The unchanged focused probe passed in this review, so its previous timeout did
not reproduce in isolation. The wait now drives the production surface tick
that the test window's `open()` bypasses, drains background work, and draws both
layout/paint turns. Success requires a connected shell, all 2,000 fixture records,
and a painted thread. The deadline remains 20 real seconds per sample; failures
report sample number, connection, inventory, paint sentinel and sidebar state.
It includes HTTP and debug CPU scheduling after opening the window; fixture
startup is outside that interval. It is not a compositor or speed-parity budget.

The combined-load sidebar run returned **39 passed, 1 failed**. Its new diagnostic
identifies an HTTP bootstrap failure in sample 8, before any rows were discovered:

```text
HTTP bootstrap must reach 2,000 records and a painted thread within 20s:
sample=8 connected=false threads=0 painted=18446744073709551615
notice="Could not reach the selected server" loading=false
```

The production client has a five-second request timeout. After a failed load,
the normal five-minute resilience cadence is outside this probe's 20-second
deadline. Waiting longer for paint cannot create missing HTTP data. This failed
run is retained separately from the passing isolated measurement; the probe
does not silently retry, increase either timeout, or turn failure into a speed
sample. Run the focused workload without concurrent whole-repository checks
for a CPU measurement; the full-run transport failure remains an open gate.

The workload remains ten first-paint samples and 500 scroll frames, with the
existing bounded-materialization assertions. The Linux test platform still
cannot supply a renderer-based screenshot or a real-font performance comparison.
