import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCanvasKeyboardGuard,
  probeCanvasKeyboardGuard,
} from "../src/host/canvasKeyboardGuard";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  window.dispatchEvent(new Event("blur"));
});

function fixture(ghost = false) {
  const key = vi.fn();
  const ghostKey = vi.fn();
  const canvas = {
    canvas: document.createElement("canvas"),
    _events_binded: true,
    _key_callback: key,
    _ghostKeyHandler: ghost ? ghostKey : null,
    state: { ghostNodeId: ghost ? "fixture-ghost" : (null as string | null) },
  };
  const host = { canvas };
  document.addEventListener("keyup", key, true);
  if (ghost) document.addEventListener("keydown", ghostKey, true);
  cleanups.push(() => {
    document.removeEventListener("keyup", key, true);
    document.removeEventListener("keydown", ghostKey, true);
    const currentKey = Object.getOwnPropertyDescriptor(
      canvas,
      "_key_callback",
    )?.value;
    const currentGhost = Object.getOwnPropertyDescriptor(
      canvas,
      "_ghostKeyHandler",
    )?.value;
    if (typeof currentKey === "function")
      document.removeEventListener("keyup", currentKey, true);
    if (typeof currentGhost === "function")
      document.removeEventListener("keydown", currentGhost, true);
  });
  return { host, canvas, key, ghostKey };
}

function acquire(host: object, invalidated = vi.fn()) {
  const result = acquireCanvasKeyboardGuard(host, invalidated);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(result.reason);
  cleanups.push(() => result.value.release());
  return result.value;
}

function key(
  type: "keydown" | "keyup" | "keypress",
  code = "KeyX",
  repeat = false,
) {
  const event = new KeyboardEvent(type, {
    key: code === "Escape" ? code : "x",
    code,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event;
}

describe("canonical canvas capture lifetime", () => {
  it("probes without removing callbacks or invoking them", () => {
    const subject = fixture(true);
    expect(probeCanvasKeyboardGuard(subject.host).status).toBe("ready");
    key("keydown");
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
    expect(subject.ghostKey).toHaveBeenCalledOnce();
  });

  it("suspends both capture callbacks and restores exact identity/capture while preserving unrelated consumers/defaults", () => {
    const subject = fixture(true);
    const foreign = vi.fn();
    document.addEventListener("keyup", foreign, true);
    cleanups.push(() => document.removeEventListener("keyup", foreign, true));
    const add = vi.spyOn(document, "addEventListener");
    const lease = acquire(subject.host);
    expect(key("keydown").defaultPrevented).toBe(false);
    expect(key("keyup").defaultPrevented).toBe(false);
    expect(subject.key).not.toHaveBeenCalled();
    expect(subject.ghostKey).not.toHaveBeenCalled();
    expect(foreign).toHaveBeenCalledOnce();
    lease.release();
    expect(add).toHaveBeenCalledWith("keyup", subject.key, true);
    expect(add).toHaveBeenCalledWith("keydown", subject.ghostKey, true);
    key("keydown");
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
    expect(subject.ghostKey).toHaveBeenCalledOnce();
  });

  it("shares nested leases, releases once, and reopens without duplicate callbacks", () => {
    const subject = fixture();
    const first = acquire(subject.host);
    const second = acquire(subject.host);
    first.release();
    first.release();
    key("keyup");
    expect(subject.key).not.toHaveBeenCalled();
    second.release();
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
    const third = acquire(subject.host);
    key("keyup");
    third.release();
    key("keyup");
    expect(subject.key).toHaveBeenCalledTimes(2);
  });

  it("removes the same callback when the host registers it again after acquisition", () => {
    const subject = fixture(true);
    const lease = acquire(subject.host);
    document.addEventListener("keyup", subject.key, true);
    document.addEventListener("keydown", subject.ghostKey, true);
    key("keydown");
    key("keyup");
    expect(subject.key).not.toHaveBeenCalled();
    expect(subject.ghostKey).not.toHaveBeenCalled();
    lease.release();
    key("keydown");
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
    expect(subject.ghostKey).toHaveBeenCalledOnce();
  });

  it("tracks replacement callbacks and never resurrects stale or cleared callbacks", () => {
    const subject = fixture(true);
    const lease = acquire(subject.host);
    const replacement = vi.fn();
    subject.canvas._key_callback = replacement;
    document.addEventListener("keyup", replacement, true);
    subject.canvas._ghostKeyHandler = null;
    subject.canvas.state.ghostNodeId = null;
    key("keyup");
    expect(replacement).not.toHaveBeenCalled();
    lease.release();
    key("keydown");
    key("keyup");
    expect(subject.key).not.toHaveBeenCalled();
    expect(subject.ghostKey).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("drains only the trailing editor keyup after release during keydown", () => {
    const subject = fixture();
    const lease = acquire(subject.host);
    const add = vi.spyOn(document, "addEventListener");
    const close = () => lease.release();
    document.body.addEventListener("keydown", close, { once: true });
    key("keydown", "Escape");
    expect(add).toHaveBeenCalledWith("keyup", subject.key, true);
    expect(key("keyup", "Escape").defaultPrevented).toBe(false);
    expect(subject.key).not.toHaveBeenCalled();
    key("keydown", "KeyY");
    key("keyup", "KeyY");
    expect(subject.key).toHaveBeenCalledOnce();
  });

  it("transfers a retained physical code to a fresh host gesture", () => {
    const subject = fixture();
    const lease = acquire(subject.host);
    key("keydown");
    lease.release();
    key("keydown");
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
  });

  it("drains trailing keypress and keyup without cancelling defaults after synchronous close", () => {
    const subject = fixture();
    const foreign = vi.fn();
    window.addEventListener("keypress", foreign);
    cleanups.push(() => window.removeEventListener("keypress", foreign));
    const lease = acquire(subject.host);
    key("keydown");
    lease.release();
    expect(key("keypress").defaultPrevented).toBe(false);
    expect(foreign).not.toHaveBeenCalled();
    expect(key("keyup").defaultPrevented).toBe(false);
    expect(subject.key).not.toHaveBeenCalled();
    key("keydown");
    key("keypress");
    key("keyup");
    expect(foreign).toHaveBeenCalledOnce();
    expect(subject.key).toHaveBeenCalledOnce();
  });

  it("rolls back partial capture installation and leaves ordinary host callbacks active", () => {
    const subject = fixture();
    const original = window.addEventListener.bind(window);
    const add = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        if (type === "keypress") throw new Error("installation refused");
        original(type, listener, options);
      });
    expect(acquireCanvasKeyboardGuard(subject.host, vi.fn()).status).toBe(
      "unavailable",
    );
    add.mockRestore();
    key("keydown");
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
  });

  it("clears retained key ownership on blur", () => {
    const subject = fixture();
    const lease = acquire(subject.host);
    key("keydown");
    lease.release();
    let facts: unknown;
    const witness = (event: Event) => {
      facts = {
        targetIsCurrent: event.target === event.currentTarget,
        targetIsNode: event.target instanceof Node,
      };
    };
    window.addEventListener("blur", witness, true);
    window.dispatchEvent(new Event("blur"));
    window.removeEventListener("blur", witness, true);
    expect(facts).toEqual({ targetIsCurrent: true, targetIsNode: false });
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
  });

  it("retains trailing editor key ownership across descendant focus blur during close", () => {
    const subject = fixture();
    const editorButton = document.createElement("button");
    const hostButton = document.createElement("button");
    document.body.append(editorButton, hostButton);
    cleanups.push(() => {
      editorButton.remove();
      hostButton.remove();
    });
    editorButton.focus();
    const lease = acquire(subject.host);
    key("keydown", "Escape");
    lease.release();
    hostButton.focus();
    key("keyup", "Escape");
    expect(subject.key).not.toHaveBeenCalled();
    key("keydown");
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
  });

  it("keeps the paired-key drain bounded when reopened before the old keyup", () => {
    const subject = fixture();
    const first = acquire(subject.host);
    key("keydown");
    first.release();
    const second = acquire(subject.host);
    key("keyup");
    second.release();
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
  });

  it.each(["canvas", "document", "bound", "callback", "ghost"])(
    "fails closed once per consumer when %s changes",
    (field) => {
      const subject = fixture();
      const invalidated = vi.fn();
      const secondInvalidated = vi.fn();
      acquire(subject.host, invalidated);
      acquire(subject.host, secondInvalidated);
      const foreign = vi.fn();
      document.addEventListener("keydown", foreign, true);
      cleanups.push(() =>
        document.removeEventListener("keydown", foreign, true),
      );
      if (field === "canvas") subject.host.canvas = { ...subject.canvas };
      if (field === "document")
        subject.canvas.canvas = document.implementation
          .createHTMLDocument()
          .createElement("canvas");
      if (field === "bound") subject.canvas._events_binded = false;
      if (field === "callback")
        Object.defineProperty(subject.canvas, "_key_callback", {
          get() {
            throw new Error("getter");
          },
        });
      if (field === "ghost") subject.canvas.state.ghostNodeId = "inconsistent";
      key("keydown");
      key("keydown", "KeyY");
      expect(foreign).not.toHaveBeenCalled();
      expect(invalidated).toHaveBeenCalledOnce();
      expect(secondInvalidated).toHaveBeenCalledOnce();
    },
  );

  it("fails closed before capture when callback removal throws", () => {
    const subject = fixture();
    const invalidated = vi.fn();
    acquire(subject.host, invalidated);
    const removal = vi
      .spyOn(document, "removeEventListener")
      .mockImplementation(() => {
        throw new Error("remove");
      });
    key("keyup");
    expect(subject.key).not.toHaveBeenCalled();
    expect(invalidated).toHaveBeenCalledOnce();
    removal.mockRestore();
  });

  it.each(["absent", "bound", "getter", "ghost", "foreign-document"])(
    "refuses unsupported %s shape without invoking foreign getters",
    (shape) => {
      const subject = fixture();
      const getter = vi.fn(() => {
        throw new Error("getter");
      });
      const host: object = shape === "absent" ? {} : subject.host;
      if (shape === "bound") subject.canvas._events_binded = false;
      if (shape === "getter")
        Object.defineProperty(subject.host, "canvas", { get: getter });
      if (shape === "ghost") subject.canvas.state.ghostNodeId = "inconsistent";
      if (shape === "foreign-document")
        subject.canvas.canvas = document.implementation
          .createHTMLDocument()
          .createElement("canvas");
      expect(probeCanvasKeyboardGuard(host).status).toBe("unavailable");
      expect(acquireCanvasKeyboardGuard(host, vi.fn()).status).toBe(
        "unavailable",
      );
      expect(getter).not.toHaveBeenCalled();
    },
  );
});

// Native ComfyApp shape: ComfyUI_frontend v1.55.11 src/scripts/app.ts:349-358.
function nativeFixture(ghost = false) {
  const subject = fixture(ghost);
  const getter = vi.fn();
  class NativeApp {
    canvasInternal = subject.canvas;
    get canvas() {
      getter();
      return this.canvasInternal;
    }
    set canvas(value: typeof subject.canvas) {
      this.canvasInternal = value;
    }
  }
  return { ...subject, host: new NativeApp(), getter };
}

describe("native accessor canvas owner", () => {
  it("probes the native class shape without calling its getter", () => {
    const subject = nativeFixture();
    expect(probeCanvasKeyboardGuard(subject.host).status).toBe("ready");
    expect(subject.getter).not.toHaveBeenCalled();
  });

  it("acquires the native class shape without calling its getter", () => {
    const subject = nativeFixture();
    const lease = acquire(subject.host);
    key("keyup");
    expect(subject.key).not.toHaveBeenCalled();
    lease.release();
    key("keyup");
    expect(subject.key).toHaveBeenCalledOnce();
    expect(subject.getter).not.toHaveBeenCalled();
  });

  it.each([
    "own-canvas",
    "missing-backing",
    "inherited-backing",
    "accessor-backing",
    "missing-getter",
    "missing-setter",
  ])("refuses %s without invoking a host getter", (shape) => {
    const subject = nativeFixture();
    const foreign = vi.fn(() => {
      throw new Error("foreign getter must not run");
    });
    const prototype = Object.getPrototypeOf(subject.host) as object;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "canvas")!;
    if (shape === "own-canvas")
      Object.defineProperty(subject.host, "canvas", { get: foreign });
    if (shape === "missing-backing" || shape === "inherited-backing") {
      Reflect.deleteProperty(subject.host, "canvasInternal");
      if (shape === "inherited-backing")
        Object.defineProperty(prototype, "canvasInternal", {
          value: subject.canvas,
        });
    }
    if (shape === "accessor-backing")
      Object.defineProperty(subject.host, "canvasInternal", { get: foreign });
    if (shape === "missing-getter" || shape === "missing-setter")
      Object.defineProperty(prototype, "canvas", {
        ...descriptor,
        get: shape === "missing-getter" ? undefined : foreign,
        set: shape === "missing-setter" ? undefined : descriptor.set,
      });
    expect(probeCanvasKeyboardGuard(subject.host).status).toBe("unavailable");
    expect(acquireCanvasKeyboardGuard(subject.host, vi.fn()).status).toBe(
      "unavailable",
    );
    expect(subject.getter).not.toHaveBeenCalled();
    expect(foreign).not.toHaveBeenCalled();
  });
});

describe.each(["legacy", "native"])("%s owner lifecycle", (shape) => {
  const create = (ghost = false) =>
    shape === "native" ? nativeFixture(ghost) : fixture(ghost);

  it.each([false, true])(
    "shares leases and restores ghost=%s callbacks",
    (ghost) => {
      const subject = create(ghost);
      const first = acquire(subject.host);
      const second = acquire(subject.host);
      key("keydown");
      key("keyup");
      first.release();
      key("keydown");
      key("keyup");
      expect(subject.key).not.toHaveBeenCalled();
      expect(subject.ghostKey).not.toHaveBeenCalled();
      second.release();
      second.release();
      key("keydown");
      key("keyup");
      expect(subject.key).toHaveBeenCalledOnce();
      expect(subject.ghostKey).toHaveBeenCalledTimes(ghost ? 1 : 0);
    },
  );

  it("restores only the current suspended callbacks after same-owner rebind", () => {
    const subject = create(true);
    const lease = acquire(subject.host);
    subject.canvas._events_binded = false;
    const replacement = vi.fn();
    subject.canvas._key_callback = replacement;
    subject.canvas._ghostKeyHandler = null;
    subject.canvas.state.ghostNodeId = null;
    document.addEventListener("keyup", replacement, true);
    subject.canvas._events_binded = true;
    key("keyup");
    expect(replacement).not.toHaveBeenCalled();
    lease.release();
    key("keydown");
    key("keyup");
    expect(replacement).toHaveBeenCalledOnce();
    expect(subject.key).not.toHaveBeenCalled();
    expect(subject.ghostKey).not.toHaveBeenCalled();
  });

  it("invalidates a replaced owner on the next key without resurrecting retired callbacks", () => {
    const subject = create();
    const firstInvalidated = vi.fn();
    const secondInvalidated = vi.fn();
    const first = acquire(subject.host, firstInvalidated);
    const second = acquire(subject.host, secondInvalidated);
    const replacement = fixture();
    subject.host.canvas = replacement.canvas;
    expect(firstInvalidated).not.toHaveBeenCalled();
    expect(secondInvalidated).not.toHaveBeenCalled();
    key("keyup");
    expect(firstInvalidated).toHaveBeenCalledOnce();
    expect(secondInvalidated).toHaveBeenCalledOnce();
    expect(replacement.key).not.toHaveBeenCalled();
    first.release();
    second.release();
    key("keyup");
    expect(replacement.key).toHaveBeenCalledOnce();
    expect(subject.key).not.toHaveBeenCalled();
  });

  it.each(["unbound", "inconsistent-ghost"])(
    "refuses a changed %s lifetime before host capture",
    (change) => {
      const subject = create();
      const invalidated = vi.fn();
      const lease = acquire(subject.host, invalidated);
      if (change === "unbound") subject.canvas._events_binded = false;
      else subject.canvas.state.ghostNodeId = "inconsistent";
      key("keyup");
      expect(invalidated).toHaveBeenCalledOnce();
      lease.release();
      key("keyup");
      expect(subject.key).not.toHaveBeenCalled();
    },
  );
});
