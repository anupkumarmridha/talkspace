/**
 * Lobby: create a room, join by code, and watch the live directory.
 *
 * The room list arrives over a WebSocket rather than by polling, so counts
 * move the instant somebody joins or leaves and an idle tab costs nothing.
 */

import { $, api, el, haptic, store, toast } from "./util.js";
import { Signal, reconnectOnResume } from "./signal.js";

const NAME_KEY = "talkspace:name";

const nameInput = $("#display-name");
const roomsList = $("#rooms");
const roomsEmpty = $("#rooms-empty");
const liveDot = $("#live-dot");

// --- Name persistence --------------------------------------------------------

nameInput.value = store.get(NAME_KEY, "") ?? "";
nameInput.addEventListener("change", () => store.set(NAME_KEY, nameInput.value.trim()));

function requireName() {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    // Scroll it clear of the on-screen keyboard.
    nameInput.scrollIntoView({ block: "center", behavior: "smooth" });
    toast("Add your name first", "error");
    return null;
  }
  store.set(NAME_KEY, name);
  return name;
}

// --- Create ------------------------------------------------------------------

// "New meeting" starts an instant meeting, named by its code, exactly as Meet
// does. The privacy choices live behind a small "Meeting options" link so
// they are one tap away but never in the way.
const createForm = $("#create-form");
const newMeetingBtn = $("#new-meeting-btn");
const optionsBtn = $("#create-options-btn");

function setCreateOpen(open) {
  createForm.hidden = !open;
  optionsBtn.setAttribute("aria-expanded", String(open));
  if (open) createForm.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

optionsBtn.addEventListener("click", () => {
  haptic();
  setCreateOpen(createForm.hidden);
});
$("#create-cancel").addEventListener("click", () => setCreateOpen(false));

async function createRoom({ isPublic, passcode }, button) {
  const name = requireName();
  if (!name) return;

  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Starting…";

  try {
    const { room } = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ isPublic, passcode: passcode || undefined }),
    });
    haptic(12);
    location.href = `/r/${room.id}`;
  } catch (err) {
    toast(err.message === "bad_json" ? "Could not create the meeting" : "Something went wrong", "error");
    button.disabled = false;
    button.textContent = label;
  }
}

newMeetingBtn.addEventListener("click", () => createRoom({ isPublic: true }, newMeetingBtn));

// The home-screen shortcut lands here wanting a new room straight away.
if (new URLSearchParams(location.search).get("new") === "1") {
  history.replaceState(null, "", "/");
  if (nameInput.value.trim()) newMeetingBtn.click();
  else nameInput.focus();
}

// The passcode field only makes sense for unlisted rooms, so it appears with
// the toggle rather than sitting there confusing everyone.
const isPublic = $("#is-public");
const passcodeWrap = $("#passcode-wrap");

isPublic.addEventListener("change", () => {
  passcodeWrap.hidden = isPublic.checked;
  if (isPublic.checked) $("#passcode").value = "";
});

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createRoom({ isPublic: isPublic.checked, passcode: $("#passcode").value }, $("#create-btn"));
});

// --- Join by code ------------------------------------------------------------

const codeInput = $("#join-code");

/**
 * Accept anything that looks like a code: with or without dashes, pasted
 * from a full URL, in any case. Typing a room code on a phone is annoying
 * enough without being strict about it.
 */
function normaliseCode(raw) {
  const fromUrl = /\/r\/([a-z0-9-]+)/i.exec(raw);
  const candidate = (fromUrl ? fromUrl[1] : raw).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (candidate.length !== 9) return null;
  return `${candidate.slice(0, 3)}-${candidate.slice(3, 6)}-${candidate.slice(6, 9)}`;
}

// Re-insert dashes as the user types, so the field always reads like a code.
// A pasted link is left alone: normaliseCode picks the code out of it.
const joinSubmit = $("#join-submit");
codeInput.addEventListener("input", () => {
  if (!/\/r\//i.test(codeInput.value)) {
    const bare = codeInput.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 9);
    const groups = bare.match(/.{1,3}/g) ?? [];
    const formatted = groups.join("-");
    if (formatted !== codeInput.value) codeInput.value = formatted;
  }
  joinSubmit.disabled = codeInput.value.trim() === "";
});

$("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = requireName();
  if (!name) return;

  const code = normaliseCode(codeInput.value);
  if (!code) {
    toast("That code does not look right", "error");
    return;
  }
  location.href = `/r/${code}`;
});

// --- Live room list ----------------------------------------------------------

function renderRooms(rooms) {
  roomsList.textContent = "";
  roomsEmpty.hidden = rooms.length > 0;

  for (const room of rooms) {
    const full = room.peerCount >= room.maxPeers;

    const item = el("li");
    const button = el("button", {
      class: "room",
      type: "button",
      disabled: full,
      "aria-label": `Join ${room.name}, ${room.peerCount} of ${room.maxPeers} people`,
      onclick: () => {
        if (!requireName()) return;
        haptic();
        location.href = `/r/${room.id}`;
      },
    });

    const body = el("div", { class: "room__body" });
    body.append(el("span", { class: "room__name" }, room.name));

    // Showing who is already inside is most of what makes a lobby inviting.
    const who = room.peers.slice(0, 3).join(", ");
    const extra = room.peerCount > 3 ? ` +${room.peerCount - 3}` : "";
    // A room named by its code has nothing new to say on the second line.
    const fallback = room.name === room.id ? "No one here yet" : room.id;
    body.append(el("span", { class: "room__meta" }, who ? who + extra : fallback));

    const count = el("span", { class: "room__count", "data-full": String(full) });
    count.append(document.createTextNode(`${room.peerCount}/${room.maxPeers}`));

    button.append(body, count);
    item.append(button);
    roomsList.append(item);
  }
}

// Render whatever the HTTP endpoint returns immediately, so the list is
// populated before the socket finishes its handshake.
api("/api/rooms")
  .then(({ rooms }) => renderRooms(rooms))
  .catch(() => {
    /* the socket will fill it in */
  });

const signal = new Signal(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/lobby`);

signal.addEventListener("open", () => {
  liveDot.textContent = "live";
  liveDot.classList.add("badge--secure");
});

signal.addEventListener("rooms", (event) => renderRooms(event.detail.rooms));

signal.addEventListener("close", () => {
  liveDot.textContent = "offline";
  liveDot.classList.remove("badge--secure");
});

signal.addEventListener("reconnecting", () => {
  liveDot.textContent = "reconnecting…";
  liveDot.classList.remove("badge--secure");
});

reconnectOnResume(signal);
signal.connect();

// --- Installability ----------------------------------------------------------

// Registering the service worker is what makes the app installable to the
// home screen, where it launches without browser chrome.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* not fatal: the app works fine uninstalled */
    });
  });
}

// Chromium hands us the install prompt to show at a moment of our choosing;
// an "Install app" button in the header is that moment. Browsers without the
// event (Safari) install through their share menu, so the button stays hidden.
let installPrompt = null;
const installBtn = $("#install-btn");

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!installPrompt) return;
  installBtn.disabled = true;
  try {
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") toast("Installed — find TalkSpace on your home screen");
  } finally {
    installPrompt = null;
    installBtn.hidden = true;
    installBtn.disabled = false;
  }
});

window.addEventListener("appinstalled", () => {
  installBtn.hidden = true;
});
