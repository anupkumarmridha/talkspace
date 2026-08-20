/**
 * Knock-to-join for private rooms.
 *
 * The contract being pinned down here:
 *  - a public room never asks anyone to wait
 *  - the owner never waits, whatever the room
 *  - an empty private room lets people straight in (nobody to ask, and no
 *    privacy to protect)
 *  - anyone else waits at the door, and while waiting is genuinely outside
 *    the room: absent from the peer list, and unable to reach participants
 *  - the host answers; if the owner is away, any participant may
 */
const B = process.env.BASE ?? "http://localhost:8787";
const WS = B.replace(/^http/, "ws");
const ORIGIN = B;

let failures = 0;
const check = (n, ok, x = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${n}${x ? "  " + x : ""}`);
  if (!ok) failures++;
};

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

const post = async (p, d) => {
  const r = await fetch(B + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(d),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

function connect(code, token) {
  const ws = new WebSocket(`${WS}/ws/room/${code}?token=${encodeURIComponent(token)}&pub=k`, {
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
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
  });

  return {
    ws,
    frames,
    get closeCode() {
      return closeCode;
    },
    open: () => new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    }),
    wait(pred, ms = 5000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        waiters.push({ pred, resolve });
        setTimeout(() => resolve(null), ms);
      });
    },
    send: (o) => ws.send(JSON.stringify(o)),
  };
}

const makeRoom = async (name, isPublic) => (await post("/api/rooms", { name, isPublic })).body;
const joinAs = async (code, name, ownerToken) =>
  (await post("/api/join", { roomId: code, name, ownerToken })).body;

// --- Public rooms never hold anyone up ---------------------------------------

console.log("\n== a public room never asks anyone to wait ==");
{
  const room = await makeRoom("Open house", true);
  const owner = connect(room.room.id, (await joinAs(room.room.id, "Owner", room.ownerToken)).token);
  await owner.open();
  await owner.wait((f) => f.t === "welcome");

  const guestJoin = await joinAs(room.room.id, "Guest");
  check("no approval flagged for a public room", guestJoin.needsApproval === false);

  const guest = connect(room.room.id, guestJoin.token);
  await guest.open();
  const welcome = await guest.wait((f) => f.t === "welcome");
  check("the guest walks straight in", Boolean(welcome));

  owner.ws.close();
  guest.ws.close();
}

// --- Private rooms ------------------------------------------------------------

console.log("\n== a private room holds strangers at the door ==");
const room = await makeRoom("Tutoring", false);
const code = room.room.id;

const ownerJoin = await joinAs(code, "Teacher", room.ownerToken);
check("the owner is never asked to wait", ownerJoin.needsApproval === false);

const owner = connect(code, ownerJoin.token);
await owner.open();
const ownerWelcome = await owner.wait((f) => f.t === "welcome");
check("the owner is host", ownerWelcome.hostId === ownerWelcome.self.id);

const studentJoin = await joinAs(code, "Student");
check("a stranger is told approval is needed", studentJoin.needsApproval === true);

const student = connect(code, studentJoin.token);
await student.open();

const waiting = await student.wait((f) => f.t === "waiting");
check("the stranger is put in the waiting room", Boolean(waiting));
check("and gets no welcome", !student.frames.some((f) => f.t === "welcome"));

const knock = await owner.wait((f) => f.t === "knock");
check("the host is told someone is at the door", knock?.peer?.name === "Student");

// While waiting they must be outside the room in every sense.
await settle();
check("a waiting peer is not announced as joined", !owner.frames.some((f) => f.t === "peer-joined"));

student.send({ t: "signal", to: ownerWelcome.self.id, payload: { sneaky: true } });
await settle();
check("a waiting peer cannot reach participants", !owner.frames.some((f) => f.payload?.sneaky));

// --- Denial -------------------------------------------------------------------

console.log("\n== the host can turn someone away ==");
owner.send({ t: "admit", target: knock.peer.id, allow: false });
const refused = await student.wait((f) => f.t === "error" && f.code === "denied");
check("the stranger is told they were declined", Boolean(refused));
await settle(600);
check("and disconnected", student.ws.readyState >= 2, `readyState=${student.ws.readyState}`);

// --- Admission ------------------------------------------------------------------

console.log("\n== the host can let someone in ==");
const second = connect(code, (await joinAs(code, "Student2")).token);
await second.open();
await second.wait((f) => f.t === "waiting");

const knock2 = await owner.wait((f) => f.t === "knock" && f.peer.name === "Student2");
owner.send({ t: "admit", target: knock2.peer.id, allow: true });

const admitted = await second.wait((f) => f.t === "welcome");
check("the admitted peer receives a welcome", Boolean(admitted));
check("and can see the host", admitted?.peers?.some((p) => p.name === "Teacher"));

const announced = await owner.wait((f) => f.t === "peer-joined" && f.peer.name === "Student2");
check("the room is told they joined", Boolean(announced));

// --- Authorisation ---------------------------------------------------------------

console.log("\n== a guest cannot open the door while the host is present ==");
const third = connect(code, (await joinAs(code, "Student3")).token);
await third.open();
await third.wait((f) => f.t === "waiting");
const knock3 = await owner.wait((f) => f.t === "knock" && f.peer.name === "Student3");

second.send({ t: "admit", target: knock3.peer.id, allow: true });
const nope = await second.wait((f) => f.t === "error" && f.code === "not_host", 4000);
check("a non-host admission is refused", Boolean(nope));
await settle();
check("the knocker is still waiting", !third.frames.some((f) => f.t === "welcome"));

// --- No host present ---------------------------------------------------------------

console.log("\n== with the owner away, anyone inside can answer ==");
owner.ws.close();
await second.wait((f) => f.t === "host" && f.id === "", 5000);

second.send({ t: "admit", target: knock3.peer.id, allow: true });
const letIn = await third.wait((f) => f.t === "welcome", 6000);
check("a participant may admit when there is no host", Boolean(letIn));

second.ws.close();
third.ws.close();

// --- Empty private room -------------------------------------------------------------

console.log("\n== an empty private room lets people straight in ==");
{
  const solo = await makeRoom("Empty private", false);
  const first = await joinAs(solo.room.id, "Anyone");
  check("no approval needed when nobody is inside", first.needsApproval === false);

  const c = connect(solo.room.id, first.token);
  await c.open();
  check("and they are admitted immediately", Boolean(await c.wait((f) => f.t === "welcome")));
  c.ws.close();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
