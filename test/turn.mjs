/**
 * The two cases that decide whether this is actually usable by strangers:
 *
 *  1. A small call (2-4 people) works completely -- everyone sees everyone,
 *     with no video dropped by the subscription cap.
 *  2. A call still connects when a direct path is impossible, which is the
 *     situation for the ~10-20% of networks behind symmetric NAT. Forcing
 *     iceTransportPolicy:"relay" reproduces that exactly: only relay
 *     candidates may be used, so the call can only succeed through TURN.
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

async function joinAs(code, name, { relayOnly = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.evaluateOnNewDocument((forceRelay) => {
    window.__pcs = [];
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(Native, args) {
        // Simulate a network with no direct path available at all.
        if (forceRelay) args[0] = { ...(args[0] ?? {}), iceTransportPolicy: "relay" };
        const pc = new Native(...args);
        window.__pcs.push(pc);
        return pc;
      },
    });
  }, relayOnly);

  await page.goto(`${BASE}/r/${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#join-btn");
  await page.$eval("#prejoin-name", (n) => {
    n.value = "";
  });
  await page.type("#prejoin-name", name);
  await page.click("#pre-cam");
  await page.click("#join-btn");
  await page.waitForSelector("#call:not([hidden])", { timeout: 25000, polling: 200 });

  return { page, name, errors };
}

const waitFor = (ctx, fn, ms = 30000) =>
  ctx.page
    .waitForFunction(fn, { timeout: ms, polling: 250 })
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

/** Video streams currently receiving RTP, measured as a rate. */
async function flowingVideo(ctx) {
  const sample = () =>
    ctx.page.evaluate(async () => {
      const out = {};
      for (const [i, pc] of (window.__pcs ?? []).entries()) {
        (await pc.getStats()).forEach((s) => {
          if (s.type === "inbound-rtp" && s.kind === "video") out[`${i}:${s.ssrc}`] = s.bytesReceived ?? 0;
        });
      }
      return out;
    });
  const a = await sample();
  await new Promise((r) => setTimeout(r, 3000));
  const b = await sample();
  return Object.keys(b).filter((k) => (b[k] ?? 0) - (a[k] ?? 0) > 5000).length;
}

try {
  // --- Zero configuration -------------------------------------------------

  console.log("\n== a relay is available without any setup ==");
  const ice = await (await fetch(`${BASE}/api/ice`)).json();
  const relayUrls = ice.iceServers
    .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
    .filter((u) => u.startsWith("turn:"));

  check("ICE config advertises TURN", ice.hasTurn === true, `source=${ice.turnSource}`);
  check("at least one relay URL is offered", relayUrls.length > 0, relayUrls.join(", "));

  // --- Small calls --------------------------------------------------------

  console.log("\n== a four-person call works completely ==");
  let code = await newRoom("Four people");
  const four = [];
  for (const name of ["Ada", "Grace", "Linus", "Edsger"]) four.push(await joinAs(code, name));

  for (const ctx of four) {
    check(
      `${ctx.name} sees all four tiles`,
      await waitFor(ctx, () => document.querySelectorAll(".tile").length === 4),
      `tiles=${await ctx.page.$$eval(".tile", (n) => n.length)}`,
    );
  }

  for (const ctx of four) {
    const connected = await waitFor(
      ctx,
      () => window.__pcs.length === 3 && window.__pcs.every((p) => p.connectionState === "connected"),
    );
    check(`${ctx.name} is connected to all three peers`, connected);
  }

  // Below the subscription cap nobody should be dropped to an avatar.
  await new Promise((r) => setTimeout(r, 4000));
  for (const ctx of four) {
    const flowing = await flowingVideo(ctx);
    check(`${ctx.name} receives all three cameras`, flowing === 3, `${flowing}/3 streaming`);
  }

  const numbers = [];
  for (const ctx of four) {
    await ctx.page.bringToFront();
    await ctx.page.click("#safety-btn");
    await waitFor(ctx, () => !/waiting/.test(document.getElementById("safety-code").textContent), 15000);
    numbers.push(await ctx.page.$eval("#safety-code", (n) => n.textContent.trim()));
    await ctx.page.keyboard.press("Escape");
  }
  check("all four agree on the safety number", new Set(numbers).size === 1, numbers.join(" | "));

  for (const ctx of four) {
    const real = ctx.errors.filter((e) => !/favicon|manifest/i.test(e));
    check(`${ctx.name} had no console errors`, real.length === 0, real.slice(0, 2).join(" | "));
  }
  for (const ctx of four) await ctx.page.close();

  // --- Relay-only ---------------------------------------------------------

  console.log("\n== a call connects with no direct path (relay only) ==");
  code = await newRoom("Behind symmetric NAT");
  const ada = await joinAs(code, "Ada", { relayOnly: true });
  const grace = await joinAs(code, "Grace", { relayOnly: true });

  const relayConnected = await waitFor(
    ada,
    () => window.__pcs.length === 1 && window.__pcs[0].connectionState === "connected",
    40000,
  );
  check("peers connect through the relay", relayConnected);

  if (relayConnected) {
    const pair = await ada.page.evaluate(async () => {
      const report = await window.__pcs[0].getStats();
      let local = "";
      let remote = "";
      const cands = new Map();
      report.forEach((s) => {
        if (s.type === "local-candidate" || s.type === "remote-candidate") cands.set(s.id, s);
      });
      report.forEach((s) => {
        if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
          local = cands.get(s.localCandidateId)?.candidateType ?? "";
          remote = cands.get(s.remoteCandidateId)?.candidateType ?? "";
        }
      });
      return { local, remote };
    });
    check("the chosen path really is a relay", pair.local === "relay", JSON.stringify(pair));

    const flowing = await flowingVideo(ada);
    check("video flows over the relay", flowing >= 1, `${flowing} stream(s)`);
  }

  await ada.page.close();
  await grace.page.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
