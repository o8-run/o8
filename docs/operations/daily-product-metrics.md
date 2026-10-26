# Daily product numbers

Run the dated usage table for the previous complete UTC day:

```sh
npm run metrics:daily
```

Choose another UTC date with `--date YYYY-MM-DD`. The command reads a complete
history export, makes only a GET request, and prints aggregates by app version.
It does not modify application settings or the telemetry store.

## Current integration status

`src/lib/analytics/server.ts` sends product events to
`POST ${proxyBaseUrl()}/v1/telemetry`. The base URL comes from `O8_PROXY_URL`,
with `https://api.o8.run` as its default. This repository contains the sending
client and local forwarding route. The hosted receiver and its data storage
live elsewhere; there is no hosted telemetry read endpoint in this repository.

The missing endpoint is an authenticated, read-only GET export of that
`/v1/telemetry` event history, with the snapshot contract below. Its actual
hosted URL must be supplied as `O8_METRICS_READ_URL`. The missing credential is
a bearer with read-only access to that export, supplied as
`O8_METRICS_READ_TOKEN`. No live URL or read credential was available for this
change. The install's sign-in entitlement authenticates ingestion and does not
establish permission to read the event store.

Both values are read from the environment only. The command never prints them,
reads credential files, or includes upstream response bodies in errors. The
export URL must use HTTPS and contain no embedded credentials, query, or
fragment. Redirects are rejected and requests have a 15-second timeout.
Every script-written line, including successful rows, help and errors, redacts
the read bearer and its trimmed form. Dates, versions, counts, rates and HTTP
statuses must match strict field patterns before they can be printed. A bearer
hidden in an otherwise valid version suffix is redacted as well.

The current sending code includes only the sanitized event and its properties.
The export service must supply the existing anonymous install ID, app version,
recorded timestamp, and unique stored event ID. This repository does not prove
that the hosted receiver already stores those fields. Any missing metadata
must be supplied by the receiver/export integration before live reporting works.
No new identity fields are added to client events by this command.

## Verified fixture

The command works now against a deterministic fixture:

```sh
npm run metrics:daily -- --fixture tests/fixtures/metrics-daily.json --date 2026-10-24
```

The output labels fixture data explicitly:

```text
Usage metrics for 2026-10-24 (UTC)
Fixture data; these are not production numbers.
| App version | New installs | Daily active installs | First worker launched | First merge | Clean-session rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1.0.0 | 1 | 1 | 1 | 1 | 100.0% (1/1) |
| 1.1.0 | 1 | 3 | 1 | 0 | 50.0% (1/2) |
```

Fixture mode performs no network request, including when read credentials are
present in the environment.

## Definitions

- New installs: anonymous installs whose first observed usage event falls on
  the report date, attributed to that first event's app version. The first-run
  disclosure gate, opt-out, and entitlement-based delivery limit this to
  observed usage.
- Daily active installs: unique anonymous install IDs with any allowlisted
  usage event on that UTC date, within each app version. An install using two
  versions on the same day appears in both version rows.
- First worker launched: each install's earliest `worker.first_launched` event
  falls on that date, attributed to that event's version.
- First merge: each install's earliest `merge.first_completed` event falls on
  that date, attributed to that event's version.
- Clean-session rate: clean `session.ended` events divided by all such events
  on that date and version. The table includes the numerator and denominator.
  A dash means no session endings were observed.

Event IDs are deduplicated before counting. Conflicting copies of one event ID
are rejected. First steps are deduplicated across the complete history, so a
repeat in a later day or version cannot become another first step. Equal-time
records use the event ID as a stable tie-breaker. No install or event IDs are
printed.

Unclean backend session endings are recovered on the next launch, subject to
the privacy gate. They count according to the export's recorded timestamp;
the client does not send an earlier end time. Earlier activity from before
these first-step markers shipped is not reconstructed.

## Read export contract

Return one JSON snapshot with `schemaVersion: 1`, `historyComplete: true`,
`completeThrough`, and an `events` array. `completeThrough` must cover at least
the midnight immediately after the requested UTC day. The snapshot must include
all historical events needed to determine first observations; a partial page
cannot be marked complete. Dates and timestamps use canonical UTC ISO strings
with milliseconds. Each event has this shape:

```json
{
  "id": "event-1",
  "installId": "anonymous-install-1",
  "appVersion": "1.0.0",
  "timestamp": "2026-10-24T12:00:00.000Z",
  "event": "session.ended",
  "props": { "clean": true }
}
```

`id` and `installId` are opaque strings containing letters, digits, underscores,
or hyphens, up to 128 characters. `appVersion` is a semantic version of at most
80 characters with optional prerelease/build suffixes. Numeric core and
prerelease identifiers cannot have leading zeroes; dot-separated identifiers
cannot be empty. Event names come from the nine-event usage allowlist;
`session.ended` requires a boolean `clean`. Other event properties are not used
by the report. Unknown events, missing metadata, incomplete coverage, and
malformed outcomes fail with a concise error instead of a misleading table.
