# Bounded write dispatch fixture

This corpus describes the verification-only Rust byte handler and the real TypeScript fallback response. It is not a production write-route oracle: production methods remain GET-only, no store gains a Rust writer, and the fixture POST admission exists only in the test child module cache and exported fixture crate.

The public-socket test expands each deterministic body recipe, checks the complete response, and sends a deferred JSON body through the canonical TypeScript writer. It compares the persisted messages exactly. The fixture builder exports source and applies scripts/o8d/verification-fixture.patch without modifying the checkout or its production route table. Build provenance is emitted beside the temporary fixture binary.

The predecessor red receipt failed at the missing native marker on a 1 KiB POST on the unchanged route-table tree; the candidate's canonical WS test passes. Additional tests prove that a private unsupported-method or disabled admission probe never executes a writer. Generic write admission requires security review before arming. Issue #6370.
