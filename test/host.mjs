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

console.log("\n== the first participant becomes host ==");
let code = (await post("/api/rooms", { name: "Host test" })).body.room.id;

const A = connect(code, await join(code, "Ada"));
await A.open();
const wa = await A.wait((f) => f.t === "welcome");
check("first joiner is host", wa.hostId === wa.self.id);

const Bp = connect(code, await join(code, "Bob"));
await Bp.open();
const wb = await Bp.wait((f) => f.t === "welcome");
check("second joiner sees the same host", wb.hostId === wa.self.id);
check("second joiner is not host", wb.hostId !== wb.self.id);

// --- Authorisation ----------------------------------------------------------

console.log("\n== only the host may act ==");
Bp.send({ t: "host", action: "kick", target: wa.self.id });
const denied = await Bp.wait((f) => f.t === "error" && f.code === "not_host");
check("a non-host kick is refused", denied.code === "not_host");
await settle();
check("the host stayed connected", A.closeCode === null, `close=${A.closeCode} reason="${A.closeReason}" frames=${JSON.stringify(A.frames.map((f) => f.t + (f.code ? "/" + f.code : "")))}`);

// --- Mute -------------------------------------------------------------------

console.log("\n== host mute and unmute are both enforced ==");
A.send({ t: "host", action: "mute", target: wb.self.id });
const muted = await Bp.wait((f) => f.t === "force-mute");
check("target receives force-mute", muted.by === "Ada");
check("it names who did it", typeof muted.by === "string" && muted.by.length > 0);

A.send({ t: "host", action: "unmute", target: wb.self.id });
const unmuted = await Bp.wait((f) => f.t === "force-unmute");
check("target receives force-unmute", unmuted.by === "Ada");

// Neither is available to a non-host.
Bp.send({ t: "host", action: "unmute", target: wa.self.id });
const deniedUnmute = await Bp.wait((f) => f.t === "error" && f.code === "not_host", 4000);
check("a non-host unmute is refused", deniedUnmute.code === "not_host");
await settle();
check("the host was not unmuted by a guest", !A.frames.some((f) => f.t === "force-unmute"));

// --- Kick -------------------------------------------------------------------

console.log("\n== host removal ==");
A.send({ t: "host", action: "kick", target: wb.self.id });
await settle(700);
check("removed participant is disconnected", Bp.closeCode === 4005, `close=${Bp.closeCode}`);

const rejoin = await post("/api/join", { roomId: code, name: "Bob" });
check("removed participant cannot walk straight back in", rejoin.status === 403, `status=${rejoin.status}`);

const other = await post("/api/join", { roomId: code, name: "Carol" });
check("the block is scoped to that person", other.status === 200, `status=${other.status}`);

// --- Handover ---------------------------------------------------------------

console.log("\n== the chair passes on when the host leaves ==");
code = (await post("/api/rooms", { name: "Handover" })).body.room.id;
const H1 = connect(code, await join(code, "Host1"));
await H1.open();
const wh1 = await H1.wait((f) => f.t === "welcome");

const H2 = connect(code, await join(code, "Next"));
await H2.open();
const wh2 = await H2.wait((f) => f.t === "welcome");
check("host is the first joiner", wh2.hostId === wh1.self.id);

H1.ws.close();
const promoted = await H2.wait((f) => f.t === "host", 5000);
check("remaining participant is promoted", promoted.id === wh2.self.id, promoted.id);

// --- Ending -----------------------------------------------------------------

console.log("\n== ending the meeting retires the code ==");
code = (await post("/api/rooms", { name: "Endable" })).body.room.id;
const E1 = connect(code, await join(code, "Owner"));
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
