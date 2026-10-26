# Product telemetry privacy

## Privacy page text

Usage analytics help us count installs that use o8 and the features they reach.
They are optional and on by default when you have not made an earlier choice.
Before usage sharing begins, the first-run privacy screen shows every event
and field and a visible Turn off button. Sharing waits until you finish that
screen, including when usage is turned off and on again. An earlier explicit
opt-out stays off after updates. An on choice stays saved, and sharing begins
after this screen is completed.

The complete usage event list is:

- app.opened: o8 was opened; no extra fields.
- brain.asked: a question was asked; no extra fields.
- orchestrator.message: a message was sent; no extra fields.
- dispatch.started: a worker dispatch began; only its known runtime category.
- merge.approved: a merge was approved; only its known runtime category and
  whether it was pushed, recorded as yes or no.
- repo.added: a project was added; only whether it has a remote and whether it
  is a version-controlled project, recorded as yes or no.
- worker.first_launched: the first successful worker launch; no extra fields.
- merge.first_completed: the first completed merge; no extra fields.
- session.ended: an o8 backend session ended; only the clean field, a yes-or-no
  value saying whether its exit was clean.

First-step markers stay on this installation across restarts and updates. Older
activity is not reconstructed. A step
that first happens while sharing is off is never replayed after sharing is
turned on. Delivery is best effort. A graceful backend shutdown is clean; an
interrupted backend is counted as unclean at the next launch. A session with
no enabled usage activity is not recovered for reporting. Live sibling backends
are not treated as interrupted sessions. No session or process identifier is
sent.

Unknown events and invalid fields are rejected. Extra fields are removed.
Usage payloads never contain code, prompts, repository names, file paths, diffs,
transcripts, file contents, credentials, user identities, or machine identities.
The current delivery path requires an existing sign-in entitlement; that
credential authenticates delivery and is never part of the event payload.
Usage payloads contain no identity fields.

To stop usage analytics, click Turn off on the first-run privacy screen, or
turn off Share usage data in Settings > General > Privacy. The choice is saved
immediately, is checked by browser and server events before sending, and stays
off after updates. A lost save response does not restore the default.

Crash reports and local crash-log uploads have separate controls and are off by
default. Usage analytics do not turn them on. The desktop update check is
separate and unchanged by this choice.

## Preference storage and first-run gate

Usage analytics are optional and default on for installs without an earlier
choice. An earlier explicit off stays off after an update. The preference is
`productTelemetryEnabled`: `null` means never chosen, `true` means explicitly
on, and `false` means explicitly off. Unset resolves to on. The canonical file
is `settings.toml` in the active data directory; `operator-defaults.json`
remains the last-good fallback. In TOML, `telemetry.product_enabled = ""`
means unset, and booleans retain their meaning. Unrelated settings saves
preserve this distinction. The operator-defaults API reads and writes the
same three values. Browser-only state never overrides the persisted choice.

On first run, o8 lists exactly what usage events contain, shows an example,
and provides one visible **Turn off** control. That click persists the opt-out
immediately without changing crash sharing or waiting for the screen's save
button. Completing the screen writes `productTelemetryEnabled`, the separate
`crashReportsEnabled` choice, and `telemetryConsentAnswered` together. Leaving
analytics at its default records `null`, not an explicit opt-in. Crash reports
still require a separate choice.

Usage analytics emit nothing until that screen is completed. The startup event
`app.opened` is then sent once for the dashboard opening if analytics remain
on. An explicit on choice cannot skip an unanswered privacy screen. Browser
and server events both re-check persisted state before egress; Settings → General → Privacy turns
sharing off immediately. Missing or malformed state cannot bypass the first-run
gate. Crash-report consent and the always-on desktop update ping are unchanged.

The wire allowlist is intentionally complete and small:

- `app.opened`, `brain.asked`, and `orchestrator.message` carry no properties.
- `dispatch.started` carries only a known worker-runtime enum.
- `merge.approved` carries only a known worker-runtime enum and `pushed` boolean.
- `repo.added` carries only `hasRemote` and `isGitRepo` booleans.
- `worker.first_launched` and `merge.first_completed` carry no properties.
- `session.ended` carries only a `clean` boolean.

Unknown events or invalid fields are rejected, and extra fields are discarded.
Code, prompts, repository names, paths, diffs, transcripts, file contents,
credentials, user identity, and machine identity are never allowed. Crash-log
upload, crash/error sharing, and user-initiated issue reports have their
own controls and do not inherit product-telemetry consent.

For example, adding a Git project with a remote sends this usage payload:

```json
{"event":"repo.added","props":{"hasRemote":true,"isGitRepo":true}}
```

Usage event payloads have no identity fields. No identity is collected beyond
sign-in; authenticated delivery uses the existing sign-in entitlement.

## Crash-report initialization

In a packaged build with a configured crash endpoint, the crash-report clients
initialize behind a blocking `beforeSend` consent check even while sharing is
off. This is deliberate: a first-run choice can take effect without relaunching,
and turning sharing off stops event egress immediately or within the 30-second
native/browser refresh budget. Off means no crash event leaves the machine; the
client code may still be loaded. The native minidump reporter is stricter and is
not started while crash sharing is off at launch.

A dedicated local-only mode is planned but not yet shipped. The shared policy
predicate already gives local-only mode precedence over product consent, so
that future resolver can fail closed without adding another telemetry
preference.
