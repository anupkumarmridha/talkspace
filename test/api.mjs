// Point at a deployment with BASE=https://... to run these against production.
const B = process.env.BASE ?? "http://localhost:8787";
const WS = B.replace(/^http/, "ws");
const ORIGIN = B;

const j = async (p, o) => {
  const r = await fetch(B + p, o);
  const b = await r.json().catch(() => ({}));
  return { status: r.status, body: b };
};
const post = (p, d) => j(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

function connect(code, token, pub) {
  const ws = new WebSocket(`${WS}/ws/room/${code}?token=${encodeURIComponent(token)}&pub=${pub}`, {
    headers: { Origin: ORIGIN },
  });
  const frames = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const f = JSON.parse(e.data);
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
    }
  });
  return {
    ws, frames,
    open: () => new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }),
    closed: () => new Promise((res) => ws.addEventListener("close", (e) => res(e))),
    wait(pred, ms = 4000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
      });
    },
    send: (o) => ws.send(JSON.stringify(o)),
  };
}

console.log("\n== room + tokens ==");
const { body: created } = await post("/api/rooms", { name: "E2E room", isPublic: true });
const code = created.room.id;
check("room created", Boolean(code), code);

const a = (await post("/api/join", { roomId: code, name: "Ada" })).body;
const b = (await post("/api/join", { roomId: code, name: "Grace" })).body;
check("two join tokens issued", Boolean(a.token && b.token));
check("peer ids are server-assigned and distinct", a.token !== b.token);

console.log("\n== connect ==");
const A = connect(code, a.token, "AAApub");
await A.open();
const wa = await A.wait((f) => f.t === "welcome");
check("A got welcome", wa.self.name === "Ada", `id=${wa.self.id}`);
check("A sees empty room", wa.peers.length === 0);

const C = connect(code, b.token, "BBBpub");
await C.open();
const wc = await C.wait((f) => f.t === "welcome");
check("B got welcome", wc.self.name === "Grace");
check("B sees Ada already present", wc.peers.length === 1 && wc.peers[0].name === "Ada");
check("B receives Ada's public key", wc.peers[0].pub === "AAApub");

const joined = await A.wait((f) => f.t === "peer-joined");
check("A notified of B joining", joined.peer.name === "Grace");

console.log("\n== blind relay ==");
A.send({ t: "signal", to: wc.self.id, payload: { kind: "desc", desc: { type: "offer", sdp: "v=0..." } } });
const relayed = await C.wait((f) => f.t === "signal");
check("payload relayed A -> B", relayed.payload?.desc?.sdp === "v=0...");
check("relay stamps verified sender id", relayed.from === wa.self.id);

// A peer must not be able to forge the sender field.
A.send({ t: "signal", to: wc.self.id, from: "somebody-else", payload: { spoof: true } });
const spoofed = await C.wait((f) => f.t === "signal" && f.payload?.spoof);
check("sender id cannot be spoofed by the client", spoofed.from === wa.self.id);

// Unicast only: a signal to a non-member must not fan out.
A.send({ t: "signal", to: "no-such-peer", payload: { leak: true } });
await new Promise((r) => setTimeout(r, 300));
check("signal to unknown peer is dropped", !C.frames.some((f) => f.payload?.leak));

console.log("\n== presence ==");
C.send({ t: "state", state: { mic: false, cam: true } });
const st = await A.wait((f) => f.t === "state");
check("state broadcast to others", st.state.mic === false && st.state.cam === true && st.id === wc.self.id);

console.log("\n== lobby ==");
await new Promise((r) => setTimeout(r, 300));
const list = (await j("/api/rooms")).body;
const listed = list.rooms.find((r) => r.id === code);
check("room appears in lobby", Boolean(listed));
check("peer count is 2", listed?.peerCount === 2, `got ${listed?.peerCount}`);
check("participant names shown", listed?.peers?.includes("Ada") && listed?.peers?.includes("Grace"));

console.log("\n== capacity ==");
const full = await post("/api/join", { roomId: code, name: "x" });
check("join allowed while room has space", full.status === 200);

console.log("\n== leave ==");
A.ws.close();
const left = await C.wait((f) => f.t === "peer-left");
check("remaining peer told who left", left.name === "Ada");

C.ws.close();
await new Promise((r) => setTimeout(r, 500));
const after = (await j("/api/rooms")).body;
check("empty room delisted", !after.rooms.some((r) => r.id === code));

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures === 0 ? 0 : 1);
