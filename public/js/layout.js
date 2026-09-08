/**
 * Stage layout: who goes where, and how big.
 *
 * Three arrangements, chosen automatically:
 *
 * - grid:    everyone gets an equal tile. On a wide screen tiles are 16:9 and
 *            sized to the largest that fits (last row centred); on a phone
 *            they fill the screen edge to edge and crop, which is what keeps
 *            faces large.
 * - pip:     phones only. When anyone else is present your own camera becomes
 *            a small floating card you can drag to any corner, and the stage
 *            belongs to the other people.
 * - pinned:  one tile (a pin, or a screen share) takes the stage and everyone
 *            else moves to a filmstrip -- along the bottom on a phone, down the
 *            right on a desktop.
 *
 * Sizes are written as CSS custom properties rather than inline widths, and
 * DOM nodes are only moved when their container actually changes, so a
 * relayout costs nothing visible.
 */

import { rafThrottle } from "./util.js";

export const WIDE = window.matchMedia("(min-width: 840px)");

const ASPECT = 16 / 9;
/** Below this a phone grid scrolls rather than shrinking faces further. */
const MIN_TILE_H = 150;
const PIP_MARGIN = 12;
const DRAG_SLOP = 8;

export class Layout {
  #stage;
  #grid;
  #strip;
  #getTiles;
  #getPinned;
  #pip = null;
  /** Which corner the self-view lives in, remembered across relayouts. */
  #pipCorner = { x: 1, y: 1 };

  #topbar;

  constructor({ stage, grid, strip, topbar, getTiles, getPinned }) {
    this.#stage = stage;
    this.#topbar = topbar ?? null;
    this.#grid = grid;
    this.#strip = strip;
    this.#getTiles = getTiles;
    this.#getPinned = getPinned;

    // Coalesced to one pass per frame -- except that a hidden tab gets no
    // frames at all, so there the work happens straight away and the stage
    // is already right when the person comes back.
    const throttled = rafThrottle(() => this.#layout());
    this.refresh = () => (document.visibilityState === "hidden" ? this.#layout() : throttled());

    new ResizeObserver(this.refresh).observe(stage);
    WIDE.addEventListener("change", this.refresh);
    document.addEventListener("visibilitychange", this.refresh);
  }

  get isWide() {
    return WIDE.matches;
  }

  #layout() {
    const tiles = this.#getTiles();
    const pinnedId = this.#getPinned();
    const wide = WIDE.matches;

    const self = tiles.find((t) => t.self && !t.screen) ?? null;
    const others = tiles.filter((t) => t !== self);

    let mode = "grid";
    let main = [];
    let strip = [];
    let pip = null;

    const pinned = pinnedId ? tiles.find((t) => t.id === pinnedId) : null;

    if (pinned) {
      mode = "pinned";
      main = [pinned];
      strip = tiles.filter((t) => t !== pinned);
    } else if (!wide && self && others.length > 0) {
      mode = "pip";
      main = others;
      pip = self;
    } else {
      main = tiles;
    }

    // Screen shares first, then people in arrival order, you last -- the
    // same order people expect from the meeting apps they already use.
    const rank = (t) => (t.screen ? 0 : t.self ? 2 : 1);
    main = [...main].sort((a, b) => rank(a) - rank(b));
    strip = [...strip].sort((a, b) => rank(a) - rank(b));

    this.#stage.dataset.mode = mode;
    this.#stage.dataset.fit = wide ? "contain" : "cover";

    this.#place(this.#grid, main);
    this.#place(this.#strip, strip);
    this.#strip.hidden = strip.length === 0;

    this.#placePip(pip);
    this.#size(main.length, wide);
  }

  /** Put exactly these tiles, in this order, inside `container`. */
  #place(container, tiles) {
    const current = [...container.children];
    const same =
      current.length === tiles.length && current.every((node, i) => node === tiles[i].root);
    if (same) return;

    for (const t of tiles) {
      t.root.classList.remove("tile--pip");
      container.append(t.root);
      // Moving a <video> between parents is harmless while it stays in the
      // document, but be explicit: a paused element would look frozen.
      const video = t.root.querySelector("video");
      if (video?.srcObject) video.play().catch(() => {});
    }
  }

  #placePip(tile) {
    if (this.#pip && this.#pip !== tile?.root) {
      this.#pip.classList.remove("tile--pip");
      this.#pip.style.removeProperty("--pip-x");
      this.#pip.style.removeProperty("--pip-y");
      this.#pip = null;
    }
    if (!tile) return;

    const root = tile.root;
    if (root.parentElement !== this.#stage) this.#stage.append(root);
    root.classList.add("tile--pip");
    if (!root.dataset.pipReady) {
      root.dataset.pipReady = "true";
      this.#makeDraggable(root);
    }
    this.#pip = root;
    this.#snapPip();
  }

  /**
   * Work out the tile size for `n` equal tiles in the grid box.
   *
   * Wide screens: maximise 16:9 tile area across every column count.
   * Phones: fill the box, one column for one or two people and two columns
   * beyond that, scrolling once tiles would drop below a usable height.
   */
  #size(n, wide) {
    const grid = this.#grid;
    const box = grid.getBoundingClientRect();
    const W = Math.max(0, box.width);
    const H = Math.max(0, box.height);
    const gap = parseFloat(getComputedStyle(grid).gap) || 8;

    grid.dataset.count = String(Math.min(12, n));

    if (n === 0 || W === 0 || H === 0) return;

    let tileW;
    let tileH;
    let scroll = false;

    if (wide) {
      let best = 0;
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const maxW = (W - gap * (cols - 1)) / cols;
        const maxH = (H - gap * (rows - 1)) / rows;
        const w = Math.min(maxW, maxH * ASPECT);
        if (w > best) best = w;
      }
      tileW = Math.floor(best);
      tileH = Math.floor(best / ASPECT);
    } else {
      const landscape = W > H;
      let cols;
      if (landscape) cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
      else cols = n <= 2 ? 1 : 2;
      const rows = Math.ceil(n / cols);

      tileW = Math.floor((W - gap * (cols - 1)) / cols);
      tileH = Math.floor((H - gap * (rows - 1)) / rows);

      if (tileH < MIN_TILE_H && n > 1) {
        tileH = MIN_TILE_H;
        scroll = true;
      }
    }

    grid.dataset.scroll = String(scroll);
    grid.style.setProperty("--tile-w", `${tileW}px`);
    grid.style.setProperty("--tile-h", `${tileH}px`);
  }

  // --- Floating self-view -----------------------------------------------------

  #makeDraggable(root) {
    let drag = null;

    root.addEventListener(
      "pointerdown",
      (event) => {
        if (!root.classList.contains("tile--pip")) return;
        drag = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          baseX: parseFloat(root.style.getPropertyValue("--pip-x")) || 0,
          baseY: parseFloat(root.style.getPropertyValue("--pip-y")) || 0,
          moved: false,
        };
        root.setPointerCapture?.(event.pointerId);
      },
      { passive: true },
    );

    root.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      root.dataset.dragging = "true";
      root.style.setProperty("--pip-x", `${drag.baseX + dx}px`);
      root.style.setProperty("--pip-y", `${drag.baseY + dy}px`);
    });

    const end = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      delete root.dataset.dragging;
      if (!moved) return;

      // Tell the tap handler this was a drag, not a tap.
      root.dataset.dragged = "true";
      setTimeout(() => delete root.dataset.dragged, 0);

      // Snap to whichever corner the card is closest to.
      const stage = this.#stage.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      const cx = box.left + box.width / 2 - stage.left;
      const cy = box.top + box.height / 2 - stage.top;
      this.#pipCorner = { x: cx < stage.width / 2 ? 0 : 1, y: cy < stage.height / 2 ? 0 : 1 };
      this.#snapPip();
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
  }

  /** Translate the self-view from its home (bottom-right) to the chosen corner. */
  #snapPip() {
    const root = this.#pip;
    if (!root) return;
    const stage = this.#stage.getBoundingClientRect();
    const pipW = root.offsetWidth || 96;
    const pipH = root.offsetHeight || 136;
    // The top bar overlays the stage, so a top corner sits just beneath it.
    const top = Math.max(
      parseFloat(getComputedStyle(this.#stage).paddingTop) || 8,
      this.#topbar?.offsetHeight ?? 0,
    );

    const travelX = stage.width - pipW - PIP_MARGIN * 2;
    const travelY = stage.height - pipH - PIP_MARGIN - top;

    const x = this.#pipCorner.x === 0 ? -travelX : 0;
    const y = this.#pipCorner.y === 0 ? -travelY : 0;
    root.style.setProperty("--pip-x", `${Math.round(x)}px`);
    root.style.setProperty("--pip-y", `${Math.round(y)}px`);
  }
}

/** Stable, pleasant hue for a name, so avatars are colourful but consistent. */
export function hueFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
