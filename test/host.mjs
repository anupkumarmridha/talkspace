/**
 * Host authority and room lifetime.
 *
 * The point of these is that authorisation is enforced by the Durable Object,
 * not by whether the client happens to render a button. Every check here
 * drives the wire protocol directly, bypassing the UI entirely.
 */
import http from "node:http";

// Point at a deployment with BASE=https://... to run these against production.
const B = process.env.BASE ?? "http://localhost:8787";
const WS = B.replace(/^http/, "ws");
const ORIGIN = B;

let failures = 0;
const check = (n, ok, x = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${n}${x ? "  " + x : ""}`);
  if (!ok) failures++;
};

const post = async (p, d) => {
  const r = await fetch(B + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(d),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

function connect(code, token) {
  const ws = new WebSocket(`${WS}/ws/room/${code}?token=${encodeURIComponent(token)}&pub=k${Math.floor(performance.now())}`, {
    headers: { Origin: ORIGIN },
  });
  const frames = [];
  const waiters = [];
  let closeCode = null;

  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const f = JSON.parse(e.data);
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) {
        waiters[i].resolve(f);
        waiters.splice(i, 1);
      }
    }
  });
  let closeReason = "";
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
    closeReason = e.reason;
  });

  return {
    ws,
    frames,
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
    open: () => new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    }),
    wait(pred, ms = 4000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error("timeout")), ms);
      });
    },
    send: (o) => ws.send(JSON.stringify(o)),
  };
}

const join = async (code, name) => (await post("/api/join", { roomId: code, name })).body.token;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// --- Host assignment --------------------------------------------------------

console.log("\n== the room's creator is its host ==");
const made = (await post("/api/rooms", { name: "Host test" })).body;
let code = made.room.id;
check("creating a room yields an owner token", typeof made.ownerToken === "string");

// Host rights come from the token, so the owner must present it when joining.
const adaJoin = (await post("/api/join", { roomId: code, name: "Ada", ownerToken: made.ownerToken })).body;
const bobJoin = (await post("/api/join", { roomId: code, name: "Bob" })).body;

const A = connect(code, adaJoin.token);
await A.open();
const wa = await A.wait((f) => f.t === "welcome");
check("the owner is host", wa.hostId === wa.self.id);

const Bp = connect(code, bobJoin.token);
await Bp.open();
const wb = await Bp.wait((f) => f.t === "welcome");
check("the other participant sees the same host", wb.hostId === wa.self.id);
check("and is not host themselves", wb.hostId !== wb.self.id);

// --- Authorisation ----------------------------------------------------------

console.log("\n== only the host may act ==");
Bp.send({ t: "host", action: "kick", target: wa.self.id });
const denied = await Bp.wait((f) => f.t === "error" && f.code === "not_host");
check("a non-host kick is refused", denied.code === "not_host");
await settle();
check("the host stayed connected", A.closeCode === null, `close=${A.closeCode}`);

// --- Mute -------------------------------------------------------------------

console.log("\n== host mute and unmute are both enforced ==");
A.send({ t: "host", action: "mute", target: wb.self.id });
const muted = await Bp.wait((f) => f.t === "force-mute");
check("target receives force-mute", muted?.by === "Ada");

A.send({ t: "host", action: "unmute", target: wb.self.id });
const unmuted = await Bp.wait((f) => f.t === "force-unmute");
check("target receives force-unmute", unmuted?.by === "Ada");

Bp.send({ t: "host", action: "unmute", target: wa.self.id });
const deniedUnmute = await Bp.wait((f) => f.t === "error" && f.code === "not_host", 4000);
check("a non-host unmute is refused", Boolean(deniedUnmute));
await settle();
check("the host was not unmuted by a guest", !A.frames.some((f) => f.t === "force-unmute"));

console.log("\n== host removal ==");
A.send({ t: "host", action: "kick", target: wb.self.id });
await settle(700);
check("removed participant is disconnected", Bp.closeCode === 4005, `close=${Bp.closeCode}`);

const rejoin = await post("/api/join", { roomId: code, name: "Bob" });
check("removed participant cannot walk straight back in", rejoin.status === 403, `status=${rejoin.status}`);

const other = await post("/api/join", { roomId: code, name: "Carol" });
check("the block is scoped to that person", other.status === 200, `status=${other.status}`);

// --- Handover ---------------------------------------------------------------

console.log("\n== the host is stable, not passed around ==");
code = (await post("/api/rooms", { name: "Handover" })).body.room.id;

// Creating the room hands out an owner token; that, and only that, confers
// host rights from here on.
const created = (await post("/api/rooms", { name: "Owned" })).body;
check("creating a room yields an owner token", typeof created.ownerToken === "string");

const owned = created.room.id;
const ownerJoin = (await post("/api/join", { roomId: owned, name: "Owner", ownerToken: created.ownerToken })).body;
check("the token holder is recognised as owner", ownerJoin.isOwner === true);

const strangerJoin = (await post("/api/join", { roomId: owned, name: "Stranger" })).body;
check("someone without the token is not", strangerJoin.isOwner !== true);

const O1 = connect(owned, ownerJoin.token);
await O1.open();
const wo1 = await O1.wait((f) => f.t === "welcome");
check("the owner is host on arrival", wo1.hostId === wo1.self.id);

const S1 = connect(owned, strangerJoin.token);
await S1.open();
const ws1 = await S1.wait((f) => f.t === "welcome");
check("the other participant sees the owner as host", ws1.hostId === wo1.self.id);

// The owner leaving must NOT promote anyone.
O1.ws.close();
const vacated = await S1.wait((f) => f.t === "host", 5000);
check("the chair is vacated, not handed over", vacated?.id === "", JSON.stringify(vacated));

// And returning restores it, despite a brand new peer id.
const back = (await post("/api/join", { roomId: owned, name: "Owner", ownerToken: created.ownerToken })).body;
const O2 = connect(owned, back.token);
await O2.open();
const wo2 = await O2.wait((f) => f.t === "welcome");
check("the owner regains host on return", wo2.hostId === wo2.self.id);
check("with a different peer id than before", wo2.self.id !== wo1.self.id);

const regained = await S1.wait((f) => f.t === "host" && f.id !== "", 5000);
check("others are told the host is back", regained?.id === wo2.self.id);

O2.ws.close();
S1.ws.close();

console.log("\n== ending the meeting retires the code ==");
const endable = (await post("/api/rooms", { name: "Endable" })).body;
code = endable.room.id;
const E1 = connect(
  code,
  (await post("/api/join", { roomId: code, name: "Owner", ownerToken: endable.ownerToken })).body.token,
);
await E1.open();
await E1.wait((f) => f.t === "welcome");
const E2 = connect(code, await join(code, "Guest"));
await E2.open();
await E2.wait((f) => f.t === "welcome");

E1.send({ t: "host", action: "end" });
await settle(1500);

// The frame is the contract. A close handshake can stall (the far end may be
// gone before it completes), so the client acts on this rather than on a
// close code it might never observe.
const endedFrames = [E1, E2].map((c) => c.frames.some((f) => f.t === "error" && f.code === "ended"));
check("everyone is told the meeting ended", endedFrames.every(Boolean), JSON.stringify(endedFrames));
check("sockets are torn down", [E1, E2].every((c) => c.ws.readyState >= 2),
  `${E1.ws.readyState}/${E2.ws.readyState}`);

const afterEnd = await post("/api/join", { roomId: code, name: "Latecomer" });
check("the code no longer admits anyone", afterEnd.status === 410, `status=${afterEnd.status}`);

// --- Lifetime ---------------------------------------------------------------

console.log("\n== a room outlives its participants ==");
code = (await post("/api/rooms", { name: "Persistent", isPublic: true })).body.room.id;
const L1 = connect(code, await join(code, "Solo"));
await L1.open();
const wl = await L1.wait((f) => f.t === "welcome");

const ttlHours = Math.round((wl.room.expiresAt - Date.now()) / 3_600_000);
check("expiry is roughly 24 hours out", ttlHours === 24, `${ttlHours}h`);

L1.ws.close();
await settle(700);

const listed = (await (await fetch(B + "/api/rooms")).json()).rooms.some((r) => r.id === code);
check("an empty room is delisted from the lobby", !listed);

const rejoinLater = await post("/api/join", { roomId: code, name: "Returning" });
check("but the code still admits people", rejoinLater.status === 200, `status=${rejoinLater.status}`);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
