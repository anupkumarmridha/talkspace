const B = process.env.BASE ?? "http://localhost:8787";
const WS = B.replace(/^http/, "ws");
const ORIGIN = B;
import http from "node:http";
import https from "node:https";

// Node's fetch refuses an Upgrade header, so drive the handshake directly to
// observe the HTTP status the Worker returns before any socket exists.
const target = new URL(B);
const upgrade = (path, origin = ORIGIN) =>
  new Promise((resolve) => {
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      { host: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path, method: "GET",
        headers: { Connection: "Upgrade", Upgrade: "websocket", Origin: origin,
                   "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("upgrade", (res) => { resolve(res.statusCode); req.destroy(); });
    req.on("error", () => resolve(0));
    req.end();
  });

const post = async (p, d) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let failures = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "  PASS" : "  FAIL"}  ${n}${x ? "  " + x : ""}`); if (!ok) failures++; };

const wsOpen = (url) => new Promise((res) => {
  const ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
  ws.addEventListener("open", () => res({ ws, ok: true }));
  ws.addEventListener("close", (e) => res({ ws, ok: false, code: e.code }));
  ws.addEventListener("error", () => {});
});

console.log("\n== passcode ==");
const secret = (await post("/api/rooms", { name: "Locked", isPublic: false, passcode: "hunter2" })).body.room;
check("room reports it is protected", secret.hasPasscode === true);
check("no passcode -> 403", (await post("/api/join", { roomId: secret.id, name: "x" })).status === 403);
check("wrong passcode -> 403", (await post("/api/join", { roomId: secret.id, name: "x", passcode: "hunter3" })).status === 403);
check("right passcode -> 200", (await post("/api/join", { roomId: secret.id, name: "x", passcode: "hunter2" })).status === 200);

console.log("\n== unlisted rooms stay unlisted ==");
const listed = (await (await fetch(B + "/api/rooms")).json()).rooms;
check("private room absent from public directory", !listed.some((r) => r.id === secret.id));

console.log("\n== token integrity ==");
const room = (await post("/api/rooms", { name: "Tok" })).body.room;
const { token } = (await post("/api/join", { roomId: room.id, name: "Ada" })).body;

const [payload, sig] = token.split(".");
const forgedName = Buffer.from(JSON.stringify({
  ...JSON.parse(Buffer.from(payload, "base64url").toString()), nm: "Administrator",
})).toString("base64url");

const cases = [
  ["tampered payload rejected", `${forgedName}.${sig}`],
  ["tampered signature rejected", `${payload}.${"A".repeat(sig.length)}`],
  ["unsigned token rejected", payload],
  ["empty token rejected", ""],
];
for (const [name, t] of cases) {
  const status = await upgrade(`/ws/room/${room.id}?token=${encodeURIComponent(t)}`);
  check(name, status === 401 || status === 400, `status=${status}`);
}

const wrongRoom = (await post("/api/rooms", { name: "Other" })).body.room;
const r2 = await upgrade(`/ws/room/${wrongRoom.id}?token=${encodeURIComponent(token)}`);
check("token bound to its own room", r2 === 401, `status=${r2}`);

console.log("\n== capacity enforcement ==");
const small = (await post("/api/rooms", { name: "Small", maxPeers: 2 })).body.room;
check("maxPeers honoured", small.maxPeers === 2, `got ${small.maxPeers}`);
const held = [];
for (let i = 0; i < 2; i++) {
  const t = (await post("/api/join", { roomId: small.id, name: `p${i}` })).body.token;
  const c = await wsOpen(`${WS}/ws/room/${small.id}?token=${encodeURIComponent(t)}`);
  held.push(c);
}
check("both seats fill", held.every((h) => h.ok));
const third = await post("/api/join", { roomId: small.id, name: "late" });
check("third join refused with 409", third.status === 409, `status=${third.status}`);
held.forEach((h) => h.ws.close());

console.log("\n== origin pinning ==");
const evil = await upgrade(`/ws/room/${room.id}?token=${encodeURIComponent(token)}`, "https://evil.example");
check("cross-origin socket refused", evil === 403, `status=${evil}`);

console.log("\n== flood control ==");
const fRoom = (await post("/api/rooms", { name: "Flood" })).body.room;
const ft = (await post("/api/join", { roomId: fRoom.id, name: "f" })).body.token;
const f = await wsOpen(`${WS}/ws/room/${fRoom.id}?token=${encodeURIComponent(ft)}`);
const closeCode = new Promise((res) => f.ws.addEventListener("close", (e) => res(e.code)));
for (let i = 0; i < 400; i++) f.ws.send(JSON.stringify({ t: "signal", to: "nobody", payload: { i } }));
const code = await Promise.race([closeCode, new Promise((r) => setTimeout(() => r(0), 3000))]);
check("flooding client is disconnected", code === 4004, `close=${code}`);

console.log("\n== oversized frame ==");
const oRoom = (await post("/api/rooms", { name: "Big" })).body.room;
const ot = (await post("/api/join", { roomId: oRoom.id, name: "o" })).body.token;
const o = await wsOpen(`${WS}/ws/room/${oRoom.id}?token=${encodeURIComponent(ot)}`);
const oClose = new Promise((res) => o.ws.addEventListener("close", (e) => res(e.code)));
o.ws.send(JSON.stringify({ t: "signal", to: "x", payload: "z".repeat(80_000) }));
const oc = await Promise.race([oClose, new Promise((r) => setTimeout(() => r(0), 3000))]);
check("oversized frame rejected", oc === 4003, `close=${oc}`);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
