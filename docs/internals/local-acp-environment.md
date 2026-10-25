# Local ACP connection environment

The Providers → Local ACP pane supports environment overrides for the saved local
ACP connection. Other runtimes continue to use their CLI configuration. A launch
selected through `O8_ACP_COMMAND` does not use these saved overrides.

Connection identity is a hash of the literal executable, ordered arguments and
OpenRouter-sharing choice. A display-name edit preserves identity. Another
executable, argument list, sharing choice or data profile gets separate settings.
Removing the current connection clears its saved overrides. Replacing it does not
apply its overrides to the replacement connection.

Up to 32 variables are supported, with conventional environment names (128
characters maximum) and values up to 8192 characters without null bytes. Process
controls, executable discovery, o8 controls, provider routing and provider keys are
reserved. Provider credentials continue through the existing sharing and billing
controls. Variables with credential-like names must be marked secret; other
values can also be marked secret.

Ordinary configuration and masked secret metadata live in the `configuration`
table of the private `acp-environment.sqlite` database. The separate `credentials`
table stores only AES-256-GCM ciphertext and IVs using the existing app master-key
resolver. Configuration and credential edits commit in one SQLite transaction.
Existing ciphertext requires the original backing key; recovery never creates a
replacement key. Inventory responses contain ordinary values and secret presence,
never secret plaintext. Leaving an existing secret value unspecified retains it;
removing its row deletes it. Saving an empty secret string is an explicit empty
override. The database is mode 0600.

The existing authenticated `/api/runtime/acp-connection` route exposes inventory
with `GET ?environment=1` and accepts an `environment` mutation containing the
connection ID, expected revision and complete variable list. Wrong credentials,
environment-controlled connections, changed connections and stale revisions are
refused. Failed validation or encryption preserves the last committed inventory.

Saved overrides take precedence over inherited values only for selected Local
ACP model probes and new conversation processes. Removing an override restores
normal inheritance. o8 does not modify its own ambient environment. The existing
provider credential filter and sandbox policy still apply. Prepared launches
recheck the exact connection and revision under the same lock used for edits and
process creation. An obsolete prepared launch refuses and can be retried.

Established conversations keep their original process environment, including
when the saved connection changes or its credential store becomes unavailable.
Provider credential revocation retains its existing behavior. Provider-pane
switches keep environment drafts in memory. Failures preserve drafts for retry;
a connection change freezes the old draft until an explicit reload. A late
response cannot clear that warning or display an obsolete inventory as current.

Saved secret values are masked in Check connection diagnostics, turn output and
errors, lifecycle errors and stderr. Matching normalizes JSON string escapes,
percent escapes, Base64 and Base64url, including mixed and nested text encodings.
Replacements apply to the original text spans. Ambiguous decoding or exceeded
normalization bounds replace the complete value.

With saved secrets present, text and thinking chunks are retained until a logical
output boundary; stderr is retained until EOF. A partial encoded tail at an
intermediate boundary is masked as a complete value. Each buffered value is capped
at 256 Ki UTF-16 code units; excess data is discarded after one redaction marker.
Normalization also bounds decoding depth, candidate views and matching work.
Connections without saved secrets retain their existing streaming behavior.
