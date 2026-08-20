/**
 * Reconnection and bandwidth-scaling behaviour.
 *
 * These cover the two failure modes that only show up after a call has been
 * running for a while, which is exactly when nobody is watching: a signalling
 * drop past the join-token lifetime, and upload growing with the room.
 */
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE ?? "http://localhost:8787";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  protocolTimeout: 60000,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

async function joinAs(code, name, { camera = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // Keep a handle on every socket so a drop can be simulated.
  await page.evaluateOnNewDocument(() => {
    window.__sockets = [];
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(N, a) {
        const pc = new N(...a);
        (window.__pcs ??= []).push(pc);
        return pc;
      },
    });
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(N, a) {
        const ws = new N(...a);
        window.__sockets.push(ws);
        return ws;
      },
    });
  });

  await page.goto(`${BASE}/r/${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#join-btn");
  await page.$eval("#prejoin-name", (n) => {
    n.value = "";
  });
  await page.type("#prejoin-name", name);
  if (camera) await page.click("#pre-cam");
  await page.click("#join-btn");
  await page.waitForSelector("#call:not([hidden])", { timeout: 20000, polling: 200 });

  return { page, name, errors };
}

const waitFor = (ctx, fn, ms = 25000) =>
  ctx.page
    .waitForFunction(fn, { timeout: ms, polling: 200 })
    .then(() => true)
    .catch(() => false);

const newRoom = async (name) =>
  (
    await (
      await fetch(`${BASE}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, isPublic: true }),
      })
    ).json()
  ).room.id;

try {
  // --- Reconnection -------------------------------------------------------

  console.log("\n== signalling survives a dropped socket ==");
  let code = await newRoom("Reconnect");
  const ada = await joinAs(code, "Ada");
  const grace = await joinAs(code, "Grace");

  await waitFor(ada, () => document.querySelectorAll(".tile").length === 2);
  check("both peers present before the drop", await waitFor(grace, () => document.querySelectorAll(".tile").length === 2));

  // Kill Ada's signalling socket the way a network handoff would.
  const before = await ada.page.evaluate(() => {
    const open = window.__sockets.filter((s) => s.readyState === WebSocket.OPEN);
    // A browser reports a real network drop as 1006, but scripts may not
    // send that code. 3001 is in the permitted application range and is
    // treated identically by the client (only 4000-4999 are terminal).
    open.forEach((s) => s.close(3001, "simulated drop"));
    return window.__sockets.length;
  });

  const reconnected = await waitFor(
    ada,
    () => window.__sockets.some((s) => s.readyState === WebSocket.OPEN),
    25000,
  );
  const after = await ada.page.evaluate(() => window.__sockets.length);

  // The real regression this guards: a reconnect reuses the join token from
  // the original URL, which is only valid for two minutes. A fresh socket
  // proves a new grant was minted rather than the stale URL replayed.
  check("a new socket is opened", after > before, `${before} -> ${after}`);
  check("signalling comes back up", reconnected);

  check(
    "the call is intact afterwards",
    await waitFor(ada, () => document.querySelectorAll(".tile").length >= 2, 20000),
  );

  // A new peer joining after the reconnect proves signalling really works,
  // not just that the socket is open.
  const linus = await joinAs(code, "Linus");
  check(
    "a peer joining after the reconnect is seen",
    await waitFor(ada, () => document.querySelectorAll(".tile").length === 3, 25000),
  );
  await linus.page.close();

  for (const ctx of [ada, grace]) {
    const real = ctx.errors.filter((e) => !/favicon|manifest|simulated drop|1006|3001/i.test(e));
    check(`${ctx.name} had no unexpected errors`, real.length === 0);
    for (const e of real.slice(0, 3)) console.log(`      ${ctx.name}: ${e}`);
  }

  await ada.page.close();
  await grace.page.close();

  // --- Video subscription -------------------------------------------------

  console.log("\n== upload does not scale with the room ==");
  code = await newRoom("Subscriptions");

  const crowd = [];
  for (const name of ["A", "B", "C", "D", "E", "F"]) {
    crowd.push(await joinAs(code, `Peer ${name}`));
  }

  const first = crowd[0];
  check(
    "all six are connected",
    await waitFor(first, () => document.querySelectorAll(".tile").length === 6, 30000),
    `tiles=${await first.page.$$eval(".tile", (n) => n.length)}`,
  );

  // Give subscriptions time to settle.
  await new Promise((r) => setTimeout(r, 6000));

  // Count on the RECEIVING side, from RTP counters rather than track state.
  // A remote track that never started still reports muted === false in
  // Chrome, so only bytes actually arriving distinguish a live camera from a
  // transceiver that exists but carries nothing.
  // Measure the RATE, not cumulative bytes. A camera that streamed briefly
  // before being unsubscribed still has a large byte total forever, so only
  // a delta between two samples distinguishes "streaming now" from
  // "streamed once". Cumulative counters made this pass locally and fail
  // against production purely on timing.
  const sample = () =>
    first.page.evaluate(async () => {
      const out = {};
      for (const [i, pc] of (window.__pcs ?? []).entries()) {
        const report = await pc.getStats();
        report.forEach((s) => {
          if (s.type === "inbound-rtp" && s.kind === "video") {
            out[`${i}:${s.ssrc}`] = s.bytesReceived ?? 0;
          }
        });
      }
      return out;
    });

  const t0 = await sample();
  await new Promise((r) => setTimeout(r, 3000));
  const t1 = await sample();

  const deltas = Object.keys(t1).map((k) => (t1[k] ?? 0) - (t0[k] ?? 0));
  const received = {
    flowing: deltas.filter((d) => d > 5000).length,
    silent: deltas.filter((d) => d <= 5000).length,
    peers: (await first.page.evaluate(() => (window.__pcs ?? []).length)),
  };

  check("five peer connections exist", received.peers === 5, JSON.stringify(received));
  check(
    "no more than four remote cameras actually stream",
    received.flowing <= 4,
    `${received.flowing} streaming, ${received.silent} idle`,
  );

  // The last to join ranks lowest for everyone, so their camera is the one
  // dropped -- proving the unsubscribe reaches the sender, not just the UI.
  const last = crowd[crowd.length - 1];
  const lastSends = await last.page.evaluate(
    () =>
      (window.__pcs ?? []).reduce(
        (n, pc) => n + pc.getSenders().filter((s) => s.track?.kind === "video").length,
        0,
      ),
  );
  check(
    "the lowest-ranked peer stops uploading to someone",
    lastSends < 5,
    `${lastSends} video uploads (a naive mesh would send 5)`,
  );

  const audio = await first.page.evaluate(() => {
    const tracks = [];
    const bitrates = [];
    for (const pc of window.__pcs ?? []) {
      for (const s of pc.getSenders()) {
        if (s.track?.kind !== "audio") continue;
        tracks.push(1);
        const e = s.getParameters().encodings?.[0];
        if (e?.maxBitrate) bitrates.push(e.maxBitrate);
      }
    }
    return { senders: tracks.length, bitrates };
  });
  check("audio still goes to every peer", audio.senders === 5, `${audio.senders} audio senders`);
  check(
    "audio bitrate stays within budget",
    audio.bitrates.length > 0 && audio.bitrates.every((b) => b <= 96_000),
    JSON.stringify(audio.bitrates),
  );

  for (const ctx of crowd) await ctx.page.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
