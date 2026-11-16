# Mobile end-to-end encryption and per-device tokens

This contract replaces a single shared mobile bearer with per-device revocable tokens and an end-to-end-encrypted WebSocket channel using ephemeral X25519 ECDH and XSalsa20-Poly1305. The desktop and mobile implementations must use this wire format without local variations.

## Why

- **Single shared token = no revocation + blast radius.** One leaked `~/.o8/ws-token` grants any device full access forever. Per-device tokens make each phone independently revocable; revoking one never touches the others or the desktop.
- **Transport isn't always TLS.** Mobile reaches the desktop over Tailscale (WireGuard-encrypted) *or* plain LAN (cleartext `ws://`). E2EE encrypts the payload end-to-end regardless of transport, and binds the session to a key in the phone's secure enclave — so a *stolen token alone* can't read or drive the channel.

## Crypto primitives (both sides — `tweetnacl`)

Pure-JS `tweetnacl` runs identically in the Node WebSocket server and the Expo/React Native runtime without a native module.

| Purpose | Primitive | tweetnacl call |
|---|---|---|
| Long-term identity (device + server) | Ed25519 | `nacl.sign.keyPair()`, `nacl.sign.detached()`, `nacl.sign.detached.verify()` |
| Per-connection ephemeral key agreement | X25519 | `nacl.box.keyPair()`, `nacl.box.before(peerPub, ownSec)` |
| Channel encryption | XSalsa20-Poly1305 | `nacl.secretbox()`, `nacl.secretbox.open()` |
| Nonces / tokens / enroll codes | CSPRNG | `nacl.randomBytes(n)` |
| Transcript hash (channel binding) | SHA-512 | `nacl.hash()` |

All wire-encoded values are **base64** (standard, not url-safe) unless noted. `tweetnacl-util` provides `encodeBase64`/`decodeBase64`/`decodeUTF8`/`encodeUTF8`.

## Identities

- **Server identity** — a persistent Ed25519 keypair at `~/.o8/e2ee-identity.key` (mode 600, created on first use). Its public key is delivered to a device out-of-band via the pairing QR (the desktop screen is a trusted channel) and pinned by the device.
- **Device identity** — an Ed25519 keypair generated on the phone at pairing; secret key lives in `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), public key is registered server-side at enrollment.
- **Ephemeral keys** — fresh X25519 keypair per WS connection on each side; discarded on disconnect. This is the forward-secrecy property.

## Per-device token + device registry

New SQLite table `mobile_devices` (`~/.o8`, Drizzle, new migration):

| column | notes |
|---|---|
| `id` | uuid, PK |
| `token_hash` | `sha256(deviceToken)` — store the **hash**; the token is shown once at enrollment |
| `device_label` | human label, e.g. "Marquise's iPhone" |
| `identity_public_key` | base64 Ed25519 device identity pub (handshake auth) |
| `created_at`, `last_seen_at`, `last_paired_at` | ISO 8601 |
| `revoked_at` | null = active; set = revoked |

**Token validation (middleware `src/middleware.ts` + WS `verifyClient`):** given a presented token —
1. constant-time-equals the shared `~/.o8/ws-token` → **accept** (desktop webview + legacy phones; never broken).
2. else `sha256(token)` → look up a `mobile_devices` row by `token_hash` with `revoked_at IS NULL` → **accept**, attach `deviceId` to the request/connection.
3. else **reject** (401 / WS close 4401).

**Revocation:** `GET /api/mobile/devices` (list), `POST /api/mobile/devices/revoke {deviceId}` (set `revoked_at`) — and force-close any live WS connection bound to that `deviceId`. Surfaced in desktop Settings (a "Paired devices" list with a Revoke action).

## Enrollment (pairing, E2EE mode)

The pairing QR no longer carries the long-lived token. It carries a **one-time enroll code** + the **server identity pub** (for pinning).

```
QR / #tk payload (E2EE mode):
{ v:1, host, apiPort, wsPort, enroll:<hex>, sIdent:<b64 server Ed25519 pub> }
```

- `enroll` — 16-byte random hex, single-use, 5-min TTL (server-side store).
- The phone generates its device identity keypair, then:

```
POST /api/mobile/enroll          (gated by the enroll code, NOT a bearer token)
  → { enroll, identityPublicKey:<b64 device Ed25519 pub>, deviceLabel }
  ← { deviceToken:<hex>, serverIdentityPublicKey:<b64> }   // 200
```

The phone **pins** `serverIdentityPublicKey` (must equal the QR's `sIdent`), stores `deviceToken` in SecureStore (replacing `o8.backend.token`), and keeps its device identity keypair + the server identity pub for the handshake.

## E2EE handshake (per WS connection, remote clients only)

Runs **after** the WS opens, the token is validated, and the server's `{channel:'system',event:'connected'}` welcome is sent. **Loopback connections skip this entirely** — same-machine desktop keeps raw frames (today's behavior). Remote vs loopback is decided by the WS upgrade socket peer address (`127.0.0.1`/`::1` = loopback).

```
1. server → client   { channel:'system', event:'e2ee-hello', data:{
       v:1, serverEphPub:<b64 X25519>, serverNonce:<b64 24B>,
       serverIdentityPub:<b64 Ed25519>,            // client pins == enrollment value
       serverSig:<b64> } }
   serverSig = Ed25519_sign("o8-e2ee-v1|hello|"+serverEphPub+"|"+serverNonce, serverIdentitySec)

2. client verifies serverSig with the pinned serverIdentityPub. Mismatch → abort (wrong/MITM server).

3. client → server   { type:'e2ee-init', v:1, clientEphPub:<b64 X25519>, clientNonce:<b64 24B>,
       clientSig:<b64> }
   clientSig = Ed25519_sign(
       "o8-e2ee-v1|init|"+clientEphPub+"|"+clientNonce+"|"+serverEphPub+"|"+serverNonce,
       deviceIdentitySec)                          // transcript binding — ties the two halves

4. server verifies clientSig with the device's registered identity_public_key (looked up by token).
   Mismatch → close 4403.

5. both derive:
   shared    = nacl.box.before(peerEphPub, ownEphSec)          // X25519 → 32B
   sessionKey = nacl.hash( shared || serverEphPub || clientEphPub ).slice(0,32)   // SHA-512, channel-bound

6. server → client   (FIRST encrypted frame) { channel:'system', event:'e2ee-ready' }
   The client decrypting it confirms key agreement. From here every frame is encrypted.
```

## Encrypted frame format (both directions, after `e2ee-ready`)

```
{ e2ee:1, n:<b64 24B nonce>, c:<b64 ciphertext> }
plaintext = nacl.secretbox.open(decodeBase64(c), decodeBase64(n), sessionKey)
          = JSON of the normal envelope: {channel,event,data}  (s→c)  /  {type,...}  (c→s)
```

- Fresh random 24-byte nonce per frame (`nacl.randomBytes(24)`).
- The handshake messages (`e2ee-hello`/`e2ee-init`) are the **only** plaintext frames after `connected`; they are authenticated by signatures, not encrypted.
- `{type:'ping'}` / `{channel:'pong'}` keepalive is encrypted too once the channel is up.

## Rollout and compatibility

Mirrors the #4/#6 playbook. Non-breaking by construction:

- **Per-device tokens ship independently of E2EE.** The token validator accepts the shared token AND per-device tokens always — so an old phone (shared token) and the desktop keep working while new pairings mint per-device tokens.
- **Enrolled-device tokens require key proof.** The server sends `e2ee-hello` to a remote enrolled client and withholds application state until the registered device key completes the handshake. Timeout or initialization failure closes the connection; there is no plaintext downgrade.
- **Legacy shared-token clients are a separate compatibility path.** They keep the established plaintext transport and never enter the enrolled-device handshake state.

## Stages (each tsc-clean + committable + gated)

**o8 desktop / ws-server side (this repo — I build):**
- **Stage 1 — Registry + identity + enrollment + revocation.** `mobile_devices` Drizzle table + migration; `e2ee-identity` keypair module (`src/lib/mobile/e2ee-identity.ts`, persistent Ed25519, pure + tested); enroll-code store; `POST /api/mobile/enroll`; `GET /api/mobile/devices` + `POST /api/mobile/devices/revoke`; token validator extended (shared OR per-device hash lookup) in `src/middleware.ts` + ws `verifyClient`; pairing route returns `enroll`+`sIdent` under the flag. Desktop "Paired devices" settings surface.
- **Stage 2 — E2EE channel.** Per-connection handshake in ws-server (remote-only): emit `e2ee-hello`, handle `e2ee-init`, verify sigs, derive `sessionKey`. Frame wrap/unwrap at the `send`/`sendRaw`/`broadcast` + `handleClientMessage` seams (encrypt only for handshaken remote connections; loopback + un-upgraded remotes stay raw). Pure crypto helpers in `src/lib/mobile/e2ee-channel.ts` (unit-tested against tweetnacl test vectors).

**o8-mobile (Expo) side — the mobile engineer builds from this spec (Stage 3):**
- Add `tweetnacl` + `tweetnacl-util`. Device identity keypair at pairing (SecureStore). Enrollment call → store per-device token + pinned server identity pub. E2EE handshake on connect (respond to `e2ee-hello`, verify, derive). Transparent frame encrypt/decrypt at the raw-frame seam (`src/o8/ws.ts` `handleRawMessage` + the `send` path) so the rest of the app still sees `{channel,event,data}`.

**Stage 4 — cross-side synthesis + dogfood.** Pair a real phone end-to-end; confirm every channel (orchestrator / inbox / history / terminal) flows encrypted; revoke a device and confirm it disconnects + can't reconnect; confirm the desktop webview + an un-upgraded client are untouched. Then flip `O8_MOBILE_E2EE` ON.

## Invariants (do not break)

- **Loopback desktop path is byte-identical** — no token-shape change, no E2EE handshake, raw frames. Decided by the WS upgrade socket peer address + the existing middleware socket-truth.
- **The shared `~/.o8/ws-token` keeps working** throughout (desktop + migration). Per-device tokens are additive.
- **Envelope shape `{channel,event,data}` / `{type,...}` is preserved** — E2EE wraps at the raw-frame layer, below the app's envelope handling, so no channel/handler code changes on either side.
- **Web push stays** — `push_subscriptions` and `/api/mobile/push/*` are unchanged, so a backgrounded phone can still receive cloud push.
- **Store token hashes, never tokens.** The device token is shown once at enrollment; the server keeps only `sha256`.

---

*Source map — o8 side: `src/ws-server.ts` (WS `verifyClient` ~4411, `send`/`sendRaw`/`broadcast` ~1535/1566/1592, `handleClientMessage` ~2472, welcome ~4429), `src/middleware.ts` (token gate ~256/310), `src/lib/ws-auth.ts` (shared token), `src/app/api/panel/mobile-pairing/route.ts` (pairing payload), `src/lib/db/schema.ts` (+ migration). Mobile side: `src/o8/ws.ts` (`handleRawMessage` ~387, send ~194, reconnect ~476), `src/o8/client.ts` (WS URL ~16), `src/o8/config.ts` (SecureStore `o8.backend.token` ~20), `src/app/pair*.tsx` (pairing), `package.json` (Expo 55, add tweetnacl).*

## Authentication outcomes and recovery

The private mobile close-code registry is `src/lib/ws-server/device-e2ee-policy.ts`.
Existing shared-token phones keep their transport and credentials. New codes and
HTTP fields are additive. A client must retain its pairing on retryable failures.

| Code | Meaning | Client action |
|---|---|---|
| 1001 | Server shutting down | Reconnect after restart |
| 4401 | Positively rejected credential (reserved) | Check credential |
| 4403 | Registered device key proof rejected | Check authentication |
| 4410 | `device_revoked`, matched retained revoked row | Remove pairing |
| 4411 | `handshake_timeout` | Retry with pairing retained |
| 4412 | `handshake_init_failed` | Retry with pairing retained |
| 4413 | `internal_error`, missing server authentication context | Retry with pairing retained |
| 4414 | `auth_unavailable`, canonical registry lookup failed | Retry with pairing retained |
| 4415 | Required handshake/encrypted framing missing | Retry with pairing retained |

Unknown credentials receive generic HTTP 401 (or WS upgrade rejection), without a
revocation marker. Only a credential matching a retained revoked row receives
HTTP 401 with `code: device_revoked` or WS 4410. Comparisons of the shared bearer
remain constant-time. No application state is sent on these rejection paths.

Unavailable HTTP auth storage returns 503, `Retry-After: 2`, and
`code: auth_unavailable`. The server rebuilds the token projection at startup.
Middleware repairs missing, unreadable or invalid projections through an
operator-authenticated internal server operation before retrying the gate.
Publication uses an owner-only temporary file and atomic rename. Active hashes
remain newline-separated; `revoked:` lines carry revoked hashes and cannot
match active credentials in older readers. The database remains canonical.

An invalid or unreadable existing server identity is preserved. Pairing and
enrollment return 503 with `code: server_identity_unavailable` and an actionable
error for Mobile settings. Restore the original identity to preserve phone pins;
only an absent identity permits key generation. Re-enrollment updates the active
identity's credential and `last_paired_at`; a revoked row is never reused.

Historical duplicate rows remain available for revocation checks. The device list
groups by phone identity, preferring an active row. Revoking a displayed phone
revokes every active row for that identity.
