/**
 * Abandoned sessions: a participant left on their own is warned, then closed.
 *
 * This suite runs its own Worker on a separate port, because it needs the
 * alone thresholds cut from minutes to seconds -- and applying that globally
 * would break every other suite, where a peer is legitimately alone for a few
 * seconds while the others are still joining.
 */
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = 8788;
const B = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;

const WARN_MS = 3000;
const CLOSE_MS = 8000;

let failures = 0;
const check = (n, ok, x = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${n}${x ? "  " + x : ""}`);
  if (!ok) failures++;
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Dedicated Worker --------------------------------------------------------

const server = spawn(
  "npx",
  [
    "wrangler", "dev",
    "--port", String(PORT),
    "--local",
    "--var", `ALONE_WARN_MS:${WARN_MS}`,
    "--var", `ALONE_CLOSE_MS:${CLOSE_MS}`,
  ],
  { stdio: "ignore", detached: true },
);

const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
};
process.on("exit", stopServer);

async function waitForServer(deadlineMs = 60000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${B}/api/rooms`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await settle(1000);
  }
  return false;
}

// --- Helpers -----------------------------------------------------------------

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
    headers: { Origin: B },
  });
  const frames = [];
  const waiters = [];

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

  return {
    ws,
    frames,
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
  };
}

const join = async (code, name) => (await post("/api/join", { roomId: code, name })).body.token;

// --- Test --------------------------------------------------------------------

try {
  console.log(`\n  starting a Worker on ${PORT} with ${WARN_MS}ms/${CLOSE_MS}ms thresholds...`);
  if (!(await waitForServer())) {
    console.error("  server did not start\n");
    process.exit(1);
  }

  console.log("\n== a session left on its own is warned, then closed ==");
  const code = (await post("/api/rooms", { name: "Abandoned" })).body.room.id;

  const stayer = connect(code, await join(code, "Stayer"));
  await stayer.open();
  await stayer.wait((f) => f.t === "welcome");

  const leaver = connect(code, await join(code, "Leaver"));
  await leaver.open();
  await leaver.wait((f) => f.t === "welcome");

  // Two people present: nobody is alone, so the timer must not be running.
  await settle(WARN_MS + 1500);
  check("no warning while two people are present", !stayer.frames.some((f) => f.t === "alone-warning"));

  leaver.ws.close();
  await stayer.wait((f) => f.t === "peer-left");

  const warned = await stayer.wait((f) => f.t === "alone-warning", WARN_MS + 6000);
  check("the lone participant is warned", Boolean(warned), warned ? `${warned.closesInMs}ms left` : "none");

  await settle(CLOSE_MS + 6000);

  // Assert on the frame, not the close code: a close initiated inside a
  // handler often never completes its handshake, which is exactly why the
  // client acts on this frame instead.
  const told = stayer.frames.some((f) => f.t === "error" && f.code === "abandoned");
  check(
    "the lone participant is told the call ended",
    told,
    JSON.stringify(stayer.frames.map((f) => f.t + (f.code ? "/" + f.code : ""))),
  );
  check("the socket is torn down", stayer.ws.readyState >= 2, `readyState=${stayer.ws.readyState}`);

  // Only the abandoned session ended; the room itself is still good.
  const later = await post("/api/join", { roomId: code, name: "Later" });
  check("the room code still works afterwards", later.status === 200, `status=${later.status}`);

  // And a rejoining participant is not immediately reaped.
  const back = connect(code, later.body.token);
  await back.open();
  await back.wait((f) => f.t === "welcome");
  await settle(1500);
  check("a fresh session is not instantly warned", !back.frames.some((f) => f.t === "alone-warning"));
  back.ws.close();
} finally {
  stopServer();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
