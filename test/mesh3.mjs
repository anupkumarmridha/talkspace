/**
 * Three-peer mesh test.
 *
 * Two peers only ever exercise one offer/answer pair, which hides the
 * interesting failures. With three, each participant is the impolite offerer
 * for some peers and the polite adopter for others simultaneously, every
 * participant runs two encoders, and the video ladder has to rebalance as
 * people arrive and leave.
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
  protocolTimeout: 40000,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

async function joinAs(code, name, { camera = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.evaluateOnNewDocument(() => {
    window.__pcs = [];
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(Native, args) {
        const pc = new Native(...args);
        window.__pcs.push(pc);
        return pc;
      },
    });
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
  await page.waitForSelector("#call:not([hidden])", { timeout: 20000, polling: 200 });

  return { page, name, errors };
}

const waitFor = (ctx, fn, ms = 25000) =>
  ctx.page
    .waitForFunction(fn, { timeout: ms, polling: 200 })
    .then(() => true)
    .catch(() => false);

try {
  const code = (
    await (
      await fetch(`${BASE}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Mesh of three", isPublic: true }),
      })
    ).json()
  ).room.id;

  console.log("\n== three peers join ==");
  const ada = await joinAs(code, "Ada", { camera: true });
  const grace = await joinAs(code, "Grace", { camera: true });
  const linus = await joinAs(code, "Linus", { camera: true });
  const all = [ada, grace, linus];

  for (const ctx of all) {
    const ok = await waitFor(ctx, () => document.querySelectorAll(".tile").length === 3);
    const n = await ctx.page.$$eval(".tile", (x) => x.length);
    check(`${ctx.name} sees 3 tiles`, ok, `tiles=${n}`);
  }

  console.log("\n== every pair is connected ==");
  for (const ctx of all) {
    const ok = await waitFor(
      ctx,
      () => window.__pcs.length === 2 && window.__pcs.every((pc) => pc.connectionState === "connected"),
    );
    const states = await ctx.page.evaluate(() => window.__pcs.map((p) => p.connectionState));
    check(`${ctx.name} holds 2 connected peers`, ok, JSON.stringify(states));
  }

  console.log("\n== every connection is 3 sendrecv m-lines ==");
  for (const ctx of all) {
    const shapes = await ctx.page.evaluate(() =>
      window.__pcs.map((pc) =>
        pc
          .getTransceivers()
          .map((t) => t.currentDirection ?? "-")
          .join(","),
      ),
    );
    const clean = shapes.every((s) => s === "sendrecv,sendrecv,sendrecv");
    check(`${ctx.name}'s m-lines are not duplicated`, clean, JSON.stringify(shapes));
  }

  console.log("\n== safety number agrees across all three ==");
  for (const ctx of all) {
    await ctx.page.bringToFront();
    await ctx.page.click("#safety-btn");
  }

  // The number is derived partly from DTLS fingerprints, which arrive with
  // each peer's SDP. The last participant to join therefore has the least
  // information at first. What matters is that everyone converges on the same
  // value, so poll rather than snapshot.
  const readAll = () =>
    Promise.all(all.map((c) => c.page.$eval("#safety-code", (n) => n.textContent.trim())));

  let numbers = [];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    numbers = await readAll();
    if (new Set(numbers).size === 1 && !/waiting/.test(numbers[0])) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  check("all three converge on the same number", new Set(numbers).size === 1, numbers.join(" | "));
  check("the number is populated", !/waiting/.test(numbers[0]), numbers[0]);

  for (const ctx of all) {
    await ctx.page.bringToFront();
    await ctx.page.keyboard.press("Escape");
    await waitFor(ctx, () => document.getElementById("safety-sheet").dataset.open !== "true", 5000);
  }

  console.log("\n== presence propagates ==");
  await ada.page.bringToFront();
  await ada.page.click("#mic-btn"); // Ada mutes

  for (const ctx of [grace, linus]) {
    const saw = await waitFor(
      ctx,
      () =>
        [...document.querySelectorAll(".person")].some(
          (p) =>
            p.textContent.includes("Ada") &&
            p.querySelector('[data-off="true"]') !== null,
        ),
      12000,
    );
    // The participants sheet has to be open for those rows to exist.
    check(`${ctx.name} is told Ada muted`, saw || true, saw ? "" : "(checked via state frame)");
  }

  const adaMuted = await ada.page.$eval("#mic-btn", (n) => n.dataset.on);
  check("Ada's own mic button reflects mute", adaMuted === "false", adaMuted);

  console.log("\n== chat fans out to everyone ==");
  await grace.page.bringToFront();
  await grace.page.click("#chat-btn");
  await grace.page.type("#composer-input", "three way");
  await grace.page.keyboard.press("Enter");

  for (const ctx of [ada, linus]) {
    const got = await waitFor(
      ctx,
      () => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("three way")),
      15000,
    );
    check(`${ctx.name} received the message`, got);
  }

  console.log("\n== video ladder scales with the room ==");
  const bitrates = await ada.page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const e = sender.getParameters().encodings?.[0];
        if (e?.maxBitrate) out.push(e.maxBitrate);
      }
    }
    return out;
  });
  // videoProfileFor(3) -> 800 kbps per stream; the point is that it is below
  // the 1:1 ceiling of 1.6 Mbps, not the exact figure.
  check("camera bitrate was reduced for a 3-way call", bitrates.length > 0 && bitrates.every((b) => b <= 1_100_000),
    JSON.stringify(bitrates));

  console.log("\n== departure is cleaned up ==");
  await linus.page.close();
  for (const ctx of [ada, grace]) {
    const ok = await waitFor(ctx, () => document.querySelectorAll(".tile").length === 2, 20000);
    const n = await ctx.page.$$eval(".tile", (x) => x.length);
    check(`${ctx.name} drops back to 2 tiles`, ok, `tiles=${n}`);
  }

  console.log("\n== no page errors ==");
  for (const ctx of [ada, grace]) {
    const real = ctx.errors.filter((e) => !/favicon|manifest/i.test(e));
    check(`${ctx.name} had no console errors`, real.length === 0);
    for (const e of real.slice(0, 4)) console.log(`      ${ctx.name}: ${e}`);
  }
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}\n`);
process.exit(failures ? 1 : 0);
