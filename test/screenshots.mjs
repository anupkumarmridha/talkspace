import puppeteer from "puppeteer-core";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:8787";

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "shell", protocolTimeout: 40000,
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",
         "--autoplay-policy=no-user-gesture-required","--no-sandbox"],
});

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };

const code = (await (await fetch(`${BASE}/api/rooms`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Design review",isPublic:true})})).json()).room.id;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function join(name, cam, viewport = PHONE, shotPrejoin = null) {
  const p = await browser.newPage();
  await p.setViewport(viewport);
  await p.goto(`${BASE}/r/${code}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#join-btn");
  await p.$eval("#prejoin-name", (n) => { n.value = ""; });
  await p.type("#prejoin-name", name);
  if (cam) await p.click("#pre-cam");
  if (shotPrejoin) {
    await wait(800);
    await p.screenshot({ path: shotPrejoin });
  }
  await p.click("#join-btn");
  await p.waitForSelector("#call:not([hidden])", { timeout: 20000, polling: 200 });
  return p;
}

// Lobby
const lobby = await browser.newPage();
await lobby.setViewport(PHONE);
await lobby.goto(BASE, { waitUntil: "networkidle2" });
await lobby.screenshot({ path: "shots/1-lobby.png" });
await lobby.click("#create-options-btn");
await wait(400);
await lobby.screenshot({ path: "shots/1b-lobby-options.png" });

const a = await join("Ada Lovelace", true, PHONE, "shots/0-prejoin.png");
await wait(1500);
await a.bringToFront();
await wait(700);
await a.screenshot({ path: "shots/2-alone.png" });

const b = await join("Grace Hopper", true);
await wait(3000);
await a.bringToFront();
await a.evaluate(() => document.querySelector(".controls").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
await wait(600);
await a.screenshot({ path: "shots/3-call.png" });

// Chrome hides itself a few seconds into a call with someone else present.
await wait(5000);
await a.screenshot({ path: "shots/3b-call-immersive.png" });
await a.tap(".grid .tile");
await wait(400);

await a.click("#more-btn");
await wait(900);
await a.screenshot({ path: "shots/4-options.png" });
await a.keyboard.press("Escape");
await wait(500);

await a.click("#more-btn");
await wait(500);
await a.click("#people-btn");
await wait(900);
await a.screenshot({ path: "shots/5-participants.png" });
await a.keyboard.press("Escape");
await wait(500);

await b.bringToFront();
await b.click("#chat-btn");
await wait(400);
await b.type("#composer-input", "Joining from the train, might drop for a second");
await b.keyboard.press("Enter");
await wait(300);
await b.type("#composer-input", "https://example.com/agenda");
await b.keyboard.press("Enter");
await a.bringToFront();
await wait(900);
await a.screenshot({ path: "shots/6a-chat-peek.png" });

await a.click("#chat-btn");
await wait(400);
await a.type("#composer-input", "Can everyone hear me?");
await a.keyboard.press("Enter");
await wait(1200);
await a.screenshot({ path: "shots/6-chat.png" });
await a.keyboard.press("Escape");
await wait(500);

await a.click("#safety-btn");
await wait(1500);
await a.screenshot({ path: "shots/7-safety.png" });
await a.keyboard.press("Escape");
await wait(500);

await a.click("#more-btn");
await wait(400);
await a.click("#invite-btn");
await wait(900);
await a.screenshot({ path: "shots/8-invite.png" });
await a.keyboard.press("Escape");
await wait(600);

// The menu button on the other person's tile opens their actions.
await a.evaluate(() => {
  const tiles = [...document.querySelectorAll(".tile")];
  const other = tiles.find((t) => !t.classList.contains("tile--self")) ?? tiles[1];
  other.querySelector(".tile__menu").click();
});
await wait(900);
await a.screenshot({ path: "shots/9-tile-actions.png" });
await a.keyboard.press("Escape");
await wait(500);

// A third person: two remote tiles stacked, self floating.
const c = await join("Katherine Johnson", false);
await wait(3500);
await a.bringToFront();
await wait(700);
await a.screenshot({ path: "shots/3c-call-three.png" });

// Pin someone: spotlight plus filmstrip.
await a.evaluate(() => {
  const tiles = [...document.querySelectorAll(".grid .tile")];
  tiles[0].querySelector(".tile__menu").click();
});
await wait(600);
await a.evaluate(() => document.querySelector("#tile-sheet .menu__item").click());
await wait(900);
await a.screenshot({ path: "shots/3d-call-pinned.png" });

// Desktop
const d = await join("Alan Turing", true, DESKTOP, "shots/d0-prejoin.png");
await wait(4000);
await d.bringToFront();
await wait(700);
await d.screenshot({ path: "shots/d1-call.png" });
await d.click("#chat-btn");
await wait(400);
await d.type("#composer-input", "Hello from the desktop");
await d.keyboard.press("Enter");
await wait(1000);
await d.screenshot({ path: "shots/d2-chat.png" });
await d.click("#people-bar-btn");
await wait(800);
await d.screenshot({ path: "shots/d3-people.png" });
await d.keyboard.press("Escape");
await wait(500);
await d.evaluate(() => {
  const tiles = [...document.querySelectorAll(".grid .tile")];
  tiles[0].querySelector(".tile__menu").click();
});
await wait(500);
await d.evaluate(() => document.querySelector("#tile-sheet .menu__item").click());
await wait(900);
await d.screenshot({ path: "shots/d4-pinned.png" });

const dl = await browser.newPage();
await dl.setViewport(DESKTOP);
await dl.goto(BASE, { waitUntil: "networkidle2" });
await dl.screenshot({ path: "shots/d5-lobby.png" });

console.log("screenshots written");
await browser.close();
