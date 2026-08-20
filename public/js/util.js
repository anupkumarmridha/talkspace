// Small shared helpers. No framework: the whole client is plain ES modules,
// which keeps the payload tiny and the first paint immediate on mobile data.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element. `text` is always set via textContent, never innerHTML. */
export function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  if (text != null) node.textContent = String(text);
  return node;
}

/** Inline SVG icon from the sprite in the page. */
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// --- Feedback ---------------------------------------------------------------

let toastHost = null;

export function toast(message, tone = "info", ms = 3200) {
  toastHost ??= document.body.appendChild(el("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const node = el("div", { class: "toast", "data-tone": tone }, message);
  toastHost.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .25s";
    setTimeout(() => node.remove(), 260);
  }, ms);
}

/**
 * Short haptic tick. Android honours this; iOS Safari ignores it silently,
 * which is fine -- it is confirmation, never the only feedback.
 */
export function haptic(pattern = 8) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

// --- Storage ----------------------------------------------------------------

/** localStorage is unavailable in some private-browsing modes; degrade quietly. */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota or disabled */
    }
  },
};

// --- Misc -------------------------------------------------------------------

export function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

/** Collapse bursts of calls into one per animation frame. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keep the screen awake during a call. The lock is dropped by the browser
 * whenever the tab is hidden, so it has to be re-acquired on visibility
 * change -- that re-acquisition is the part people usually miss.
 */
export function createWakeLock() {
  let lock = null;
  let wanted = false;

  async function acquire() {
    if (!wanted || lock || document.visibilityState !== "visible") return;
    try {
      lock = await navigator.wakeLock?.request("screen");
      lock?.addEventListener("release", () => {
        lock = null;
      });
    } catch {
      /* denied or unsupported */
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") acquire();
  });

  return {
    enable() {
      wanted = true;
      return acquire();
    },
    async disable() {
      wanted = false;
      try {
        await lock?.release();
      } catch {
        /* already gone */
      }
      lock = null;
    },
  };
}

/** Native share sheet where available, clipboard everywhere else. */
export async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (err) {
      // AbortError means the user dismissed the sheet -- not a failure.
      if (err?.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `http_${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
