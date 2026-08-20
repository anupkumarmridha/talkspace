/**
 * Draggable bottom sheet.
 *
 * This is most of what separates "a website on a phone" from "an app". The
 * details that matter:
 *
 * - The drag tracks your finger 1:1, and the release decision uses velocity,
 *   not just distance. Flicking a sheet 40px should dismiss it; dragging it
 *   slowly 40px should not.
 * - Dragging is cancelled if the sheet's content is scrolled away from the
 *   top, so swiping through chat history never accidentally closes the sheet.
 * - Pointer Events cover touch, mouse and pen in one path, with capture so a
 *   finger that leaves the element still delivers moves.
 * - On wide screens the CSS turns the sheet into a side rail and dragging is
 *   disabled, because dragging a desktop panel is not a real gesture.
 */

const DISMISS_DISTANCE = 96; // px
const DISMISS_VELOCITY = 0.5; // px per ms

export class Sheet {
  #root;
  #scrim;
  #body;
  #onClose;
  #drag = null;
  #open = false;

  constructor(root, { scrim, body, onClose } = {}) {
    this.#root = root;
    this.#scrim = scrim ?? null;
    this.#body = body ?? root.querySelector(".sheet__body");
    this.#onClose = onClose;

    const grip = root.querySelector(".sheet__grip");
    if (grip) {
      grip.addEventListener("pointerdown", this.#onDown, { passive: true });
      grip.addEventListener("pointermove", this.#onMove, { passive: false });
      grip.addEventListener("pointerup", this.#onUp);
      grip.addEventListener("pointercancel", this.#onUp);
    }

    this.#scrim?.addEventListener("click", () => this.close());

    // Escape closes, matching every native modal.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.#open) this.close();
    });
  }

  get isOpen() {
    return this.#open;
  }

  open() {
    if (this.#open) return;
    this.#open = true;
    this.#root.dataset.open = "true";
    this.#root.removeAttribute("inert");
    if (this.#scrim) this.#scrim.dataset.open = "true";
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    this.#root.dataset.open = "false";
    this.#root.style.transform = "";
    // inert keeps a closed sheet out of the tab order and off screen readers.
    this.#root.setAttribute("inert", "");
    if (this.#scrim) this.#scrim.dataset.open = "false";
    this.#onClose?.();
  }

  toggle() {
    this.#open ? this.close() : this.open();
  }

  // --- Drag -----------------------------------------------------------------

  #onDown = (event) => {
    // The side-rail layout has no grip, but guard anyway.
    if (!this.#open || window.innerWidth >= 700) return;

    this.#drag = {
      startY: event.clientY,
      lastY: event.clientY,
      lastT: event.timeStamp,
      velocity: 0,
      pointerId: event.pointerId,
    };
    this.#root.dataset.dragging = "true";
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  #onMove = (event) => {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    // Only if the content is at the top; otherwise this is a scroll.
    if (this.#body && this.#body.scrollTop > 0) return;

    const dy = event.clientY - drag.startY;
    if (dy < 0) return; // no rubber-banding upward past the open position

    // Claim the gesture so the page does not scroll underneath.
    event.preventDefault();

    const dt = event.timeStamp - drag.lastT;
    if (dt > 0) drag.velocity = (event.clientY - drag.lastY) / dt;
    drag.lastY = event.clientY;
    drag.lastT = event.timeStamp;

    this.#root.style.transform = `translateY(${dy}px)`;
  };

  #onUp = (event) => {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#drag = null;

    delete this.#root.dataset.dragging;
    this.#root.style.transform = "";

    const travelled = drag.lastY - drag.startY;
    // Either a decisive flick or a long drag dismisses.
    if (travelled > DISMISS_DISTANCE || drag.velocity > DISMISS_VELOCITY) this.close();
  };
}
