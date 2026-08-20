# TalkSpace

Free, end-to-end encrypted group calls that run entirely on Cloudflare's free
tier. Open a link, type a name, talk. No account, no install, no server in the
media path.

- **Audio + video + screen share** over WebRTC
- **Encrypted chat** peer-to-peer, with an encrypted fallback
- **Browsable lobby** of live public rooms, plus join-by-code
- **Host controls** — mute, unmute, remove, end the meeting
- **Rooms live 24 hours**, so a link shared in the morning still works tonight
- **Mobile-first PWA** — installs to a home screen and runs without browser chrome

---

## Why it is free, and stays free

The single decision that drives everything else: **media never touches a
server.** Every participant connects directly to every other participant in a
full mesh. Cloudflare only relays a few kilobytes of signalling per call.

```
   Ada ────────── Grace          Cloudflare Worker + Durable Object
    │  ╲        ╱  │             ─────────────────────────────────
    │    ╲    ╱    │             · who is in the room
    │      ╳       │             · relays SDP / ICE between them
    │    ╱    ╲    │             · never sees or stores media
   Linus ──────── Bob            · never sees chat plaintext
```

The cost of a video call normally *is* the egress. With a mesh there is none,
so the bill is a handful of Durable Object requests.

A naive mesh has each peer upload one copy of its video **per other
participant**, which stops working at around six people. Two things push that
out to twelve without adding a server:

**Receiver-driven video subscription.** There is no point uploading video to
someone who is not displaying it. Each client tells the others whose cameras it
actually wants — the pinned tile, whoever is sharing a screen, then the most
recent speakers — capped at four. Everyone else's camera is paused *for that
recipient specifically*, and they appear as an avatar. This is what an SFU does
with its forwarding decisions, done by the receivers instead.

**Audio never unsubscribes**, because you must always hear everyone; its
per-stream bitrate tapers instead (96 → 64 → 40 kbps as the room grows).

The result: a peer in a twelve-person room uploads at most four video streams
plus eleven small audio streams, instead of eleven of each.

Past twelve you genuinely need an SFU, which means egress billing and a
different architecture. That is the point at which this stops being free.

**What keeps idle rooms free:** an empty room stops its heartbeat entirely and
schedules a single wake-up at expiry. An unused room costs one alarm per day,
not one every 45 seconds. WebSocket keepalives are answered by the runtime's
auto-response, so they never wake your code at all.

---

## Security model

**Media is end-to-end encrypted and cannot be otherwise.** WebRTC media is
DTLS-SRTP, terminating in the two browsers. In a mesh there is no server in the
path to decrypt it — this is a property of the topology, not a promise.

**Chat** prefers an `RTCDataChannel`, which rides the same peer-to-peer DTLS
session, so the server does not merely refuse to read it — it never receives
it. When a direct connection cannot be established, chat falls back to a blind
relay carrying **AES-GCM ciphertext** under a **pairwise ECDH (P-256) → HKDF**
key. Sender, recipient and sequence number are bound into the AAD, and the
receiver rejects any sequence that does not advance, so the relay cannot
re-attribute, misroute or replay a message.

**Verifying there is no one in the middle.** The server routes every signalling
frame, so in principle it could substitute a public key. Defence is the same as
Signal's: a **safety number** every participant computes independently, over
everyone's public keys *and* their DTLS certificate fingerprints. Read it aloud
on the call you are already on. If it matches, nobody is in the middle —
including the media path, because the DTLS fingerprint is part of it.

Tap the shield icon to see it:

```
        🐨  🎸  ☂️  🍇  🌵
          183 111 310 590
```

**A tamper-evident log, not a blockchain.** Each client keeps an append-only
hash chain of key events (joins, public keys, DTLS fingerprints), where every
entry commits to all previous ones. It exists to catch a key that *changes
mid-call* — you get an explicit warning if it does. This is the useful kernel of
the "blockchain" idea with none of the cost: no consensus, no network, no token,
no shared ledger to attack. A real blockchain would add seconds of latency to
something budgeted in milliseconds, cost money per write, and publish call
metadata permanently. It would not improve confidentiality by one bit.

**Also enforced**

| | |
|---|---|
| Join tokens | HMAC-signed, 120s TTL, bound to one room; peer ids are minted server-side so identity cannot be forged |
| Room passcodes | Salted SHA-256, compared in constant time |
| WebSocket origin | Same-origin only (WebSockets are exempt from CORS) |
| Flood control | Per-peer token bucket, 40/s sustained; oversized frames close the socket |
| Host actions | Authorised in the Durable Object, never by the presence of a button |
| CSP | `script-src 'self' 'wasm-unsafe-eval'`, no inline script or style anywhere |
| Chat rendering | `textContent` only — never `innerHTML` |

**Not claimed:** if nobody compares the safety number, a malicious server could
MITM the *fallback chat channel*. Display names and room membership are visible
to the server. Metadata privacy is a different and much harder problem.

---

## Host controls

The first person to join takes the chair; if they leave it passes to whoever
has been present longest. Every action is authorised inside the Durable Object
— the client hides buttons from non-hosts as a courtesy, but that is not what
enforces it.

| Action | Behaviour |
|---|---|
| **Mute** | Enforced. The participant's client mutes on receipt, no prompt. |
| **Unmute** | Enforced. Applied immediately, and always announced to them. |
| **Remove** | Disconnects them and blocks rejoining for two minutes. |
| **End meeting** | Disconnects everyone and retires the room code permanently. |

Reach them by tapping someone's tile, or from the participants list.

> **A note on enforced unmute.** Meet, Zoom and Teams will all *ask* rather
> than unmute you. Their reasoning is that muting only reduces what a
> microphone captures while unmuting increases it, so it needs consent. This
> build enforces it, by explicit request. The mitigation is that the
> participant always gets a prominent notice the moment it happens and can mute
> again instantly — a microphone never goes live silently. If you would prefer
> the standard consent-based behaviour, change the `unmute` branch in
> `src/signal-room.ts` to send an advisory frame instead.

---

## Running it locally

**Requirements:** Node 18+. (Rust is only needed if you want to rebuild the
WASM module — a prebuilt `public/wasm/dsp.wasm` is committed.)

```bash
npm install
npm run dev
```

Open <http://localhost:8787>.

To test a real call you need two participants. Any of these work:

- Two browser windows (use one normal and one private window — the display name
  is stored in `localStorage` and is shared between tabs of the same profile)
- Two devices on your network, via `npx wrangler dev --ip 0.0.0.0` and your
  machine's LAN address
- Two different browsers

> **Camera and microphone need a secure context.** `localhost` counts as secure,
> so local development works. Any other host must be HTTPS or the browser will
> refuse to hand over the devices.

### Testing

Start the dev server in one terminal, then in another:

```bash
npm test              # everything: typecheck + 7 suites
```

Or individually:

| Command | What it covers |
|---|---|
| `npm run typecheck` | TypeScript, Worker + Durable Objects |
| `npm run test:api` | Signalling: join, relay, presence, lobby, departure |
| `npm run test:security` | Tokens, passcodes, origin pinning, flood, capacity |
| `npm run test:host` | Host authority, handover, removal, 24h lifetime |
| `npm run test:crypto` | ECDH/AES-GCM, AAD binding, safety number, hash chain |
| `npm run test:browser` | Two real Chrome instances: connection, media, chat |
| `npm run test:mesh` | Three peers: every pair connected, ladder, cleanup |
| `npm run test:resilience` | Reconnect after a dropped socket; video subscription caps |

The browser suites drive real Chrome with fake capture devices, and assert on
`RTCPeerConnection` state and RTP counters rather than on the DOM alone. They
expect Chrome at `/Applications/Google Chrome.app` — edit `CHROME` in
`test/browser.mjs` and `test/mesh3.mjs` on other platforms.

---

## Deploying

```bash
npx wrangler login
npm run deploy
```

That is the whole deployment. Durable Objects with the SQLite backend are
available on the Workers Free plan, and static assets are served from
Cloudflare's edge without invoking the Worker.

### Adding a TURN server (strongly recommended)

Roughly 10–20% of real users sit behind symmetric NAT or a firewall that blocks
direct UDP. Those calls **cannot connect** without a relay. The app now says so
explicitly when a peer fails, rather than leaving a black tile, but the fix is
to configure TURN.

One manual step is unavoidable: the OAuth token from `wrangler login` has no
Realtime scope, so a TURN key cannot be created with credentials the CLI
already holds.

1. [Create an API token](https://dash.cloudflare.com/profile/api-tokens) →
   **Custom token** → permission **Account · Cloudflare Realtime · Edit**
2. Run:

```bash
CLOUDFLARE_API_TOKEN=xxx npm run setup:turn
npm run deploy
```

That creates the key, stores `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` as Worker
secrets, and prints how to verify. Confirm with:

```bash
curl -s https://<your-worker>/api/ice | grep hasTurn
```

The Worker mints short-lived per-user credentials on `/api/ice`; long-lived
credentials are never sent to a browser. Any standard TURN server works too via
`TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`.

**Cost:** TURN egress is $0.05/GB after a free 1,000 GB per month. Only the
minority of connections that cannot go direct use the relay at all, so ordinary
usage stays inside the free allowance. STUN is free and unlimited.

---

## How it is put together

```
src/
  index.ts        Worker: routing, join tokens, ICE, security headers
  signal-room.ts  Durable Object, one per room — presence + blind relay
  lobby.ts        Durable Object, one global — live room directory
  crypto.ts       HMAC join tokens, passcode hashing, room codes
  ice.ts          STUN/TURN resolution
  protocol.ts     The wire contract, shared by both objects

public/
  js/mesh.js      Peer connections, perfect negotiation, fixed transceivers
  js/e2ee.js      ECDH + AES-GCM, safety number, hash chain
  js/media.js     Capture, Opus/video tuning, remote playback
  js/vad.js       Voice detection façade
  js/vad-worklet.js  Audio-thread processor hosting the WASM
  js/sheet.js     Draggable bottom sheet
  js/room.js      Call orchestration
  js/lobby.js     Lobby

wasm/dsp/         Rust voice-activity detector → wasm32 (9.4 KB, no deps)
test/             Six suites, two of them real-browser
```

### Choices worth explaining

**Fixed transceivers.** Every connection creates exactly three m-lines up front
— audio, camera, screen — before any SDP exists. Toggling the camera or starting
a screen share is then just `replaceTrack()`, with no renegotiation at all.
Screen sharing is instant instead of a round trip.

**One side offers.** If both peers create transceivers and both offer, the
collision does not merge — you get six half-duplex m-lines instead of three
`sendrecv` ones. So the peer with the lower id creates everything and offers;
the other creates nothing and adopts what it is offered, flipping direction to
`sendrecv` before answering so no second round trip is needed.

**One certificate per session.** Each `RTCPeerConnection` would otherwise mint
its own DTLS certificate, so a participant would present a different fingerprint
to each peer and no room-wide safety number could exist.

**Rust → WASM for the voice detector, and nowhere else.** The VAD runs on the
realtime audio thread ~375×/second per participant; that is genuinely CPU-bound
and a missed deadline is audible. It is `no_std`, allocation-free, has zero
dependencies, and falls back to JS if the module fails to load. It is an
analysis-only tap — the microphone track reaches the peer connection untouched,
so a bug here can make the speaking ring wrong but can never affect audio.

**Rust was the wrong answer for the backend.** The signalling path is pure I/O —
parse a small JSON frame, find a socket, forward bytes — with nothing for Rust to
speed up, and `workers-rs` has weak support for WebSocket Hibernation, which is
exactly the feature that keeps idle rooms free.

**No React.** The hot path is the speaking ring updating ~46×/second per
participant; the current code writes `dataset.speaking` inside a
`requestAnimationFrame` batch, which is the shortest path to the compositor.
Reconciliation would sit between the audio thread and that pixel and add ~45 KB
before first paint, for a UI of eight tiles and a chat list. Zero dependencies
also means no build step between you and a deploy.

**Audio is tuned to be loud and clear.** Opus is pushed to 96 kbps mono with
in-band FEC and DTX off — the ~32 kbps default is the usual reason WebRTC voice
sounds thin. Remote audio optionally runs through a compressor and limiter so a
quiet speaker on a laptop mic stays intelligible.

**Video adapts to the room.** Uplink in a mesh is `(N-1) × bitrate`, so a fixed
number is always wrong. The ladder runs 1.6 Mbps for a 1:1 down to 320 kbps at
capacity, keeping total upload near 3 Mbps. Desktop prefers VP9 for
quality-per-bit; phones prefer H.264, because a phone running several software
encoders throttles and ends up *worse*.

---

## Configuration

`wrangler.jsonc`:

| Setting | Default | Notes |
|---|---|---|
| `MAX_PEERS_PER_ROOM` | `12` | Mesh limit. Raising it degrades calls before it fails them |
| `ROOM_IDLE_TIMEOUT_MS` | `120000` | How long a stale lobby entry survives |

Room lifetime (`ROOM_TTL_MS`) and the removal cool-off (`KICK_BLOCK_MS`) are in
`src/protocol.ts`.

---

## Known limits

- **12 people.** Video subscription keeps upload flat, but audio still goes to
  everyone and each peer still runs several encoders. Past this you need an SFU.
- **At most 4 remote cameras visible at once**, chosen by pin, screen share,
  then recent speech. Everyone else shows as an avatar — this is the trade that
  buys the higher headcount.
- **No TURN by default** — a minority of networks will fail to connect until you
  run `npm run setup:turn`. Failures are now reported rather than silent.
- **Chat is not persisted.** That is deliberate: the server stores no messages,
  so someone joining late sees no history.
- **Host is the first joiner**, passing to the longest-present participant when
  they leave. There are no accounts, so there is no stronger notion of
  ownership — and the removal block is by display name, which is a speed bump
  rather than access control.
- **Safety numbers only help if someone checks them.**

## Licence

MIT
