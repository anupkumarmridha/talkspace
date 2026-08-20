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

// The passcode field only makes sense for unlisted rooms, so it appears with
// the toggle rather than sitting there confusing everyone.
const isPublic = $("#is-public");
const passcodeWrap = $("#passcode-wrap");

isPublic.addEventListener("change", () => {
  passcodeWrap.hidden = isPublic.checked;
  if (isPublic.checked) $("#passcode").value = "";
});

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = requireName();
  if (!name) return;

  const button = $("#create-btn");
  button.disabled = true;
  button.textContent = "Creating…";

  try {
    const { room } = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: $("#room-name").value.trim() || `${name}'s room`,
        isPublic: isPublic.checked,
        passcode: $("#passcode").value || undefined,
      }),
    });
    haptic(12);
    location.href = `/r/${room.id}`;
  } catch (err) {
    toast(err.message === "bad_json" ? "Could not create the room" : "Something went wrong", "error");
    button.disabled = false;
    button.textContent = "Create room";
  }
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
codeInput.addEventListener("input", () => {
  const bare = codeInput.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 9);
  const groups = bare.match(/.{1,3}/g) ?? [];
  const formatted = groups.join("-");
  if (formatted !== codeInput.value) codeInput.value = formatted;
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
    body.append(el("span", { class: "room__meta" }, who ? who + extra : room.id));

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
