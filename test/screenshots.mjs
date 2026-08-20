import puppeteer from "puppeteer-core";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:8787";

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "shell", protocolTimeout: 40000,
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",
         "--autoplay-policy=no-user-gesture-required","--no-sandbox"],
});

const code = (await (await fetch(`${BASE}/api/rooms`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Design review",isPublic:true})})).json()).room.id;

async function join(name, cam) {
  const p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.goto(`${BASE}/r/${code}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#join-btn");
  await p.$eval("#prejoin-name", (n) => { n.value = ""; });
  await p.type("#prejoin-name", name);
  if (cam) await p.click("#pre-cam");
  await p.click("#join-btn");
  await p.waitForSelector("#call:not([hidden])", { timeout: 20000, polling: 200 });
  return p;
}

// Lobby
const lobby = await browser.newPage();
await lobby.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await lobby.goto(BASE, { waitUntil: "networkidle2" });
await lobby.screenshot({ path: "shots/1-lobby.png" });

const a = await join("Ada Lovelace", true);
await new Promise((r) => setTimeout(r, 1500));
await a.bringToFront();
await a.screenshot({ path: "shots/2-alone.png" });

const b = await join("Grace Hopper", true);
await new Promise((r) => setTimeout(r, 4000));
await a.bringToFront();
await a.screenshot({ path: "shots/3-call.png" });

await a.click("#more-btn");
await new Promise((r) => setTimeout(r, 900));
await a.screenshot({ path: "shots/4-options.png" });
await a.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));

await a.click("#more-btn");
await new Promise((r) => setTimeout(r, 500));
await a.click("#people-btn");
await new Promise((r) => setTimeout(r, 900));
await a.screenshot({ path: "shots/5-participants.png" });
await a.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));

await a.click("#chat-btn");
await a.type("#composer-input", "Can everyone hear me?");
await a.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 1200));
await a.screenshot({ path: "shots/6-chat.png" });
await a.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));

await a.click("#safety-btn");
await new Promise((r) => setTimeout(r, 1500));
await a.screenshot({ path: "shots/7-safety.png" });
await a.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));

await a.click("#more-btn");
await new Promise((r) => setTimeout(r, 400));
await a.click("#invite-btn");
await new Promise((r) => setTimeout(r, 900));
await a.screenshot({ path: "shots/8-invite.png" });

console.log("screenshots written");
await browser.close();
