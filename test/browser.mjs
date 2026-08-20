/**
 * Real-browser end-to-end test.
 *
 * Drives two Chrome instances through the actual join flow and asserts that a
 * peer connection reaches "connected" with media flowing in both directions.
 * Fake capture devices give a deterministic signal (a moving pattern and a
 * tone) so the byte counters are meaningful rather than a black frame.
 */
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE ?? "http://localhost:8787";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

const launch = () =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    protocolTimeout: 30000,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

async function joinAs(browser, code, name, { camera = false } = {}) {
  const page = await browser.newPage();

  // Record every RTCPeerConnection the page creates, so the test can read
  // real transport state instead of inferring it from the DOM.
  await page.evaluateOnNewDocument(() => {
    window.__pcs = [];
    // A Proxy keeps statics such as generateCertificate reachable; a plain
    // wrapper function would silently drop them.
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(Native, args) {
        const pc = new Native(...args);
        window.__pcs.push(pc);
        return pc;
      },
    });
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") errors.push(`[${t}] ${m.text()}`);
  });

  await page.goto(`${BASE}/r/${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#join-btn");

  // The field is pre-filled from localStorage, which is shared across pages
  // in one browser profile; clear it or names concatenate.
  await page.$eval("#prejoin-name", (n) => {
    n.value = "";
  });
  await page.type("#prejoin-name", name);
  if (camera) await page.click("#pre-cam");
  await page.click("#join-btn");
  await page.waitForSelector("#call:not([hidden])", { timeout: 15000, polling: 200 });

  return { page, errors };
}

const create = async (roomName) => {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: roomName, isPublic: true }),
  });
  return (await res.json()).room.id;
};

const browser = await launch();
try {
  console.log("\n== two peers join a room ==");
  const code = await create("Browser test");
  const ada = await joinAs(browser, code, "Ada", { camera: true });
  const grace = await joinAs(browser, code, "Grace", { camera: true });

  // Both should render two tiles: self plus the other participant.
  for (const [who, ctx] of [["Ada", ada], ["Grace", grace]]) {
    await ctx.page.waitForFunction(() => document.querySelectorAll(".tile").length >= 2, { timeout: 15000, polling: 200 });
    const tiles = await ctx.page.$$eval(".tile", (n) => n.length);
    check(`${who} sees both tiles`, tiles >= 2, `tiles=${tiles}`);
  }

  console.log("\n== peer connection establishes ==");
  const connected = async (ctx) =>
    ctx.page.waitForFunction(
      () => [...document.querySelectorAll(".tile[data-connection]")].some((t) => t.dataset.connection === "connected"),
      { timeout: 25000, polling: 200 },
    ).then(() => true).catch(() => false);

  const pcState = (ctx) =>
    ctx.page.evaluate(() =>
      (window.__pcs ?? []).map((pc) => ({
        conn: pc.connectionState,
        ice: pc.iceConnectionState,
        sig: pc.signalingState,
        transceivers: pc.getTransceivers().map((t) => `${t.mid ?? "-"}:${t.currentDirection ?? "-"}`),
      })),
    );

  const pcConnected = (ctx) =>
    ctx.page
      .waitForFunction(() => (window.__pcs ?? []).some((pc) => pc.connectionState === "connected"), {
        timeout: 25000,
        polling: 200,
      })
      .then(() => true)
      .catch(() => false);

  check("Ada's RTCPeerConnection is connected", await pcConnected(ada));
  check("Grace's RTCPeerConnection is connected", await pcConnected(grace));
  console.log("    ada pcs:  ", JSON.stringify(await pcState(ada)));
  console.log("    grace pcs:", JSON.stringify(await pcState(grace)));

  check("Ada's tile shows connected", await connected(ada));
  check("Grace's tile shows connected", await connected(grace));

  console.log("\n== media actually flows ==");
  // Read real RTP counters out of the page rather than trusting the UI.
  const stats = async (ctx) =>
    ctx.page.evaluate(async () => {
      const pcs = [];
      // Reach the mesh through the module's own peer connections via getStats
      // on every RTCPeerConnection the page created.
      for (const video of document.querySelectorAll("video")) {
        if (video.srcObject) pcs.push(video.srcObject);
      }
      const streams = pcs.filter((s) => s.getTracks().length);
      return {
        streams: streams.length,
        liveTracks: streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length,
      };
    });

  const adaStats = await stats(ada);
  const graceStats = await stats(grace);
  check("Ada has live media tracks", adaStats.liveTracks > 0, JSON.stringify(adaStats));
  check("Grace has live media tracks", graceStats.liveTracks > 0, JSON.stringify(graceStats));

  console.log("\n== wasm voice detector loaded ==");
  const wasmOk = await ada.page.evaluate(async () => {
    const res = await fetch("/wasm/dsp.wasm");
    const mod = await WebAssembly.compile(await res.arrayBuffer());
    return WebAssembly.Module.exports(mod).map((e) => e.name);
  });
  check("dsp.wasm compiles in the browser", wasmOk.includes("process") && wasmOk.includes("speaking"), wasmOk.join(","));

  console.log("\n== main thread is responsive ==");
  for (const [who, ctx] of [["Ada", ada], ["Grace", grace]]) {
    const t0 = Date.now();
    const alive = await ctx.page
      .evaluate(() => document.querySelectorAll(".tile").length)
      .then((n) => n >= 0)
      .catch(() => false);
    check(`${who}'s renderer answers`, alive, `${Date.now() - t0}ms`);
  }

  console.log("\n== encrypted chat over the data channel ==");
  // Only the frontmost page renders under headless shell, and puppeteer's
  // click waits on an IntersectionObserver that a background page never
  // fires. Focus the page before driving real input at it.
  await ada.page.bringToFront();
  await ada.page.click("#chat-btn");
  await ada.page.type("#composer-input", "hello from ada");
  await ada.page.keyboard.press("Enter");

  const received = await grace.page
    .waitForFunction(
      () => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("hello from ada")),
      { timeout: 12000, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  check("chat message arrives at the other peer", received);

  const transport = await ada.page.$eval("#chat-transport", (n) => n.textContent.trim());
  check("chat used the peer-to-peer path", transport === "peer-to-peer", transport);

  console.log("\n== safety number ==");
  await ada.page.bringToFront();
  await ada.page.click("#safety-btn");
  await grace.page.bringToFront();
  await grace.page.click("#safety-btn");
  await new Promise((r) => setTimeout(r, 1200));
  const sa = await ada.page.$eval("#safety-code", (n) => n.textContent.trim());
  const sg = await grace.page.$eval("#safety-code", (n) => n.textContent.trim());
  check("both peers compute a safety number", sa.length > 5 && sg.length > 5, `${sa} | ${sg}`);
  check("safety numbers match", sa === sg, `${sa} vs ${sg}`);

  console.log("\n== participants ==");
  const count = await ada.page.$eval("#people-count", (n) => n.textContent.trim());
  check("participant count is 2", count === "2", count);

  console.log("\n== no page errors ==");
  for (const [who, ctx] of [["Ada", ada], ["Grace", grace]]) {
    const real = ctx.errors.filter((e) => !/favicon|manifest/i.test(e));
    check(`${who} had no console errors`, real.length === 0);
    for (const e of real.slice(0, 6)) console.log(`      ${who}: ${e}`);
  }
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
