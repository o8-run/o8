# Bounded write dispatch fixture

This corpus describes the verification-only Rust byte handler and the real TypeScript fallback response. It is not a production write-route oracle: production methods remain GET-only, no store gains a Rust writer, and the fixture POST admission exists only in the test child module cache and exported fixture crate.

The public-socket test expands each deterministic body recipe, checks the complete response, and sends a deferred JSON body through the canonical TypeScript writer. It compares the persisted messages exactly. The fixture builder exports source and applies scripts/o8d/verification-fixture.patch without modifying the checkout or its production route table. Build provenance is emitted beside the temporary fixture binary.

The predecessor red receipt failed at the missing native marker on a 1 KiB POST on the unchanged route-table tree; the candidate's canonical WS test passes. Additional tests prove that a private unsupported-method or disabled admission probe never executes a writer. Generic write admission requires security review before arming. Issue #6370.

The unauthorized oversized probe declares 16 MiB + 1 and withholds its body. It requires the complete canonical 401 refusal within ten seconds, identically with native reads enabled and disabled. This proves admission precedes body consumption without racing a streaming uploader against an early refusal/close; the queue's prior full-upload fetch observed ECONNRESET. Authenticated exact-limit and over-limit probes still send their complete payloads.

The admission socket fixture performs its first canonical fallback read during bounded setup, including lazy store initialization. Its protocol test keeps the original 30-second deadline and now bounds each socket response at five seconds. A retained diagnostic measured three 204 admissions in 35–241 ms, followed by 51.98 seconds of cold fallback loading, explaining the former timeout (#6408). Recovery health/build deadline failures are retained in the receipt; hosted CI remains the gate.
