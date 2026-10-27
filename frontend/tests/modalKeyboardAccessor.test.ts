import { describe, expect, it, vi } from "vitest";
import {
  acquireModalKeyboardGuard,
  probeModalKeyboardGuard,
} from "../src/host/modalKeyboardGuard";
import { createModalKeyboardHost } from "./support/hostSeamTestDouble";

const member = "maskeditor_is_opended";
function acquire(host: object) {
  const result = acquireModalKeyboardGuard(host);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(result.reason);
  return result.value;
}

describe("store-backed host modal predicate", () => {
  it("installs through the compatibility setter and contains direct-store undo and redo", () => {
    const original = vi.fn(() => false);
    const subject = createModalKeyboardHost("accessor", original);
    const before = Object.getOwnPropertyDescriptor(
      subject.constructor,
      "maskeditor_is_opended",
    );
    let undoActions = 0;
    const changeTracker = (key: "z" | "y") => {
      if (subject.store.predicate?.()) return;
      if (["z", "y"].includes(key)) undoActions += 1;
    };
    changeTracker("z");
    expect(undoActions).toBe(1);
    const result = acquireModalKeyboardGuard(subject.host);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.reason);
    expect(subject.store.predicate?.()).toBe(true);
    changeTracker("z");
    changeTracker("y");
    expect(undoActions).toBe(1);
    expect(
      Object.getOwnPropertyDescriptor(
        subject.constructor,
        "maskeditor_is_opended",
      ),
    ).toEqual(before);
    result.value.release();
    expect(subject.store.predicate).toBe(original);
    changeTracker("y");
    expect(undoActions).toBe(2);
  });

  it("probes only the descriptor, then installs a null initial hook through the host setter", () => {
    const subject = createModalKeyboardHost("accessor");
    const original = Object.getOwnPropertyDescriptor(
      subject.constructor,
      member,
    )!;
    const get = vi.fn(original.get!);
    const set = vi.fn(original.set!);
    Object.defineProperty(subject.constructor, member, {
      ...original,
      get,
      set,
    });
    const before = Object.getOwnPropertyDescriptor(subject.constructor, member);
    expect(probeModalKeyboardGuard(subject.host).status).toBe("ready");
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    const lease = acquire(subject.host);
    expect(lease.tier).toBe("accessor");
    expect(subject.store.predicate?.()).toBe(true);
    const handedOut = subject.store.predicate!;
    lease.release();
    expect(subject.store.predicate).toBeNull();
    expect(handedOut()).toBe(false);
    expect(set).toHaveBeenCalledTimes(2);
    expect(
      Object.getOwnPropertyDescriptor(subject.constructor, member),
    ).toEqual(before);
  });

  it.each([false, true])(
    "shares nested leases with reverse order %s and releases once",
    (reverse) => {
      const subject = createModalKeyboardHost("accessor");
      const first = acquire(subject.host);
      const wrapper = subject.store.predicate;
      const second = acquire(subject.host);
      expect(subject.store.predicate).toBe(wrapper);
      const leases = reverse ? [second, first] : [first, second];
      leases[0]!.release();
      leases[0]!.release();
      expect(subject.store.predicate?.()).toBe(true);
      leases[1]!.release();
      expect(subject.store.predicate).toBeNull();
      acquire(subject.host).release();
      expect(subject.store.predicate).toBeNull();
    },
  );

  it("preserves external replacements and delegates inactive wrappers to the saved receiver", () => {
    const original = vi.fn(function (this: unknown, argument: unknown) {
      return { receiver: this, argument };
    });
    const subject = createModalKeyboardHost("accessor", original);
    const lease = acquire(subject.host);
    const wrapper = subject.store.predicate!;
    const external = () => wrapper("external");
    subject.constructor.maskeditor_is_opended = external;
    expect(acquireModalKeyboardGuard(subject.host).status).toBe("unavailable");
    expect(external()).toBe(true);
    lease.release();
    expect(subject.store.predicate).toBe(external);
    expect(wrapper.call({}, "argument")).toEqual({
      receiver: subject.constructor,
      argument: "argument",
    });
    expect(external()).toEqual({
      receiver: subject.constructor,
      argument: "external",
    });
  });

  it("refuses nesting after an external descriptor freeze and restores through the original setter", () => {
    const subject = createModalKeyboardHost("accessor");
    const lease = acquire(subject.host);
    Object.freeze(subject.constructor);
    expect(acquireModalKeyboardGuard(subject.host).status).toBe("unavailable");
    lease.release();
    expect(subject.store.predicate).toBeNull();
  });

  it("refuses a constructor frozen by the accessor setter during installation", () => {
    const subject = createModalKeyboardHost("accessor");
    let handedOut: (() => unknown) | null = null;
    Object.defineProperty(subject.constructor, member, {
      set(value: typeof subject.store.predicate) {
        subject.store.predicate = value;
        if (value !== null) {
          handedOut = value;
          Object.freeze(subject.constructor);
        }
      },
    });
    expect(acquireModalKeyboardGuard(subject.host).status).toBe("unavailable");
    expect(subject.store.predicate).toBeNull();
    expect(handedOut).not.toBeNull();
    expect(handedOut!()).toBe(false);
  });

  it.each(
    (["setter", "readback"] as const).flatMap((stage) =>
      (["get", "set", "configurable", "enumerable"] as const).map((part) => ({
        stage,
        part,
      })),
    ),
  )("refuses descriptor $part replacement during $stage", ({ stage, part }) => {
    const subject = createModalKeyboardHost("accessor");
    let foreign: PropertyDescriptor | undefined;
    let handedOut: (() => unknown) | null = null;
    const replace = () => {
      const changed: PropertyDescriptor = {
        get: () => subject.store.predicate,
        set: (value: typeof subject.store.predicate) => {
          subject.store.predicate = value;
        },
        configurable: false,
        enumerable: true,
      };
      Object.defineProperty(subject.constructor, member, {
        [part]: changed[part],
      });
      foreign = Object.getOwnPropertyDescriptor(subject.constructor, member);
    };
    Object.defineProperty(subject.constructor, member, {
      get() {
        if (stage === "readback" && handedOut !== null && foreign === undefined)
          replace();
        return subject.store.predicate;
      },
      set(value: typeof subject.store.predicate) {
        subject.store.predicate = value;
        if (value !== null) {
          handedOut = value;
          if (stage === "setter") replace();
        }
      },
    });
    expect(acquireModalKeyboardGuard(subject.host).status).toBe("unavailable");
    expect(handedOut).not.toBeNull();
    expect(handedOut!()).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(subject.constructor, member),
    ).toEqual(foreign);
    expect(subject.store.predicate).toBe(
      part === "get" || part === "set" ? handedOut : null,
    );
  });

  it("refuses a descriptor trap after accessor value readback and restores best-effort", () => {
    const subject = createModalKeyboardHost("accessor");
    let failRead = false;
    let handedOut: (() => unknown) | null = null;
    Object.defineProperty(subject.constructor, member, {
      set(value: typeof subject.store.predicate) {
        subject.store.predicate = value;
        if (value !== null) {
          handedOut = value;
          failRead = true;
        }
      },
    });
    const constructor = new Proxy(subject.constructor, {
      getOwnPropertyDescriptor(target, key) {
        if (key === member && failRead) {
          failRead = false;
          throw new Error("descriptor readback");
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(
      acquireModalKeyboardGuard(Object.create({ constructor })).status,
    ).toBe("unavailable");
    expect(subject.store.predicate).toBeNull();
    expect(handedOut!()).toBe(false);
  });

  it("refuses a data define trap that lies about installing the wrapper", () => {
    const subject = createModalKeyboardHost("data");
    let handedOut: (() => unknown) | null = null;
    const constructor = new Proxy(subject.constructor, {
      defineProperty(target, key, next) {
        if (typeof next.get === "function") {
          handedOut = next.get() as () => unknown;
          return true;
        }
        return Reflect.defineProperty(target, key, next);
      },
    });
    expect(
      acquireModalKeyboardGuard(Object.create({ constructor })).status,
    ).toBe("unavailable");
    expect(Reflect.get(subject.constructor, member)).toBeNull();
    expect(handedOut!()).toBe(false);
  });

  it.each([false, undefined, {}, 0])(
    "does not write a non-callable first accessor value %j",
    (value) => {
      const subject = createModalKeyboardHost("accessor");
      Reflect.set(subject.constructor, member, value);
      const before = Object.getOwnPropertyDescriptor(
        subject.constructor,
        member,
      );
      const lease = acquire(subject.host);
      expect(lease.tier).toBe("absent");
      expect(Reflect.get(subject.constructor, member)).toBe(value);
      lease.release();
      expect(
        Object.getOwnPropertyDescriptor(subject.constructor, member),
      ).toEqual(before);
      expect(Reflect.get(subject.constructor, member)).toBe(value);
    },
  );

  it("refuses a throwing first getter without calling its setter", () => {
    const subject = createModalKeyboardHost("accessor");
    const set = vi.fn();
    Object.defineProperty(subject.constructor, member, {
      get() {
        throw new Error("getter");
      },
      set,
    });
    expect(probeModalKeyboardGuard(subject.host).status).toBe("ready");
    expect(acquireModalKeyboardGuard(subject.host)).toEqual({
      status: "unavailable",
      reason: "modal_keyboard_guard_unavailable",
    });
    expect(set).not.toHaveBeenCalled();
  });

  it("restores after a no-op setter causes a read-back mismatch", () => {
    const subject = createModalKeyboardHost("accessor");
    const set = vi.fn();
    Object.defineProperty(subject.constructor, member, { set });
    expect(acquireModalKeyboardGuard(subject.host).status).toBe("unavailable");
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(null);
    expect(subject.store.predicate).toBeNull();
  });

  it.each(["setter", "readback"])(
    "deactivates and restores a partial install after %s throws",
    (failure) => {
      const subject = createModalKeyboardHost("accessor");
      let handedOut: (() => unknown) | null = null;
      Object.defineProperty(subject.constructor, member, {
        get() {
          if (failure === "readback" && subject.store.predicate !== null)
            throw new Error("readback");
          return subject.store.predicate;
        },
        set(value: typeof subject.store.predicate) {
          subject.store.predicate = value;
          if (value !== null) {
            handedOut = value;
            if (failure === "setter") throw new Error("setter");
          }
        },
      });
      expect(acquireModalKeyboardGuard(subject.host).status).toBe(
        "unavailable",
      );
      expect(subject.store.predicate).toBeNull();
      expect(handedOut).not.toBeNull();
      expect(handedOut!()).toBe(false);
    },
  );

  it("never redefines the accessor, even through a constructor proxy", () => {
    const subject = createModalKeyboardHost("accessor");
    const defineProperty = vi.fn(() => {
      throw new Error("redefine");
    });
    const constructor = new Proxy(subject.constructor, { defineProperty });
    const lease = acquire(Object.create({ constructor }) as object);
    expect(subject.store.predicate?.()).toBe(true);
    lease.release();
    expect(subject.store.predicate).toBeNull();
    expect(defineProperty).not.toHaveBeenCalled();
  });

  it("never adopts its own inactive wrapper after a store setter starts throwing", () => {
    const original = vi.fn(() => false);
    const subject = createModalKeyboardHost("accessor", original);
    let frozen = false;
    Object.defineProperty(subject.constructor, member, {
      set(value: typeof subject.store.predicate) {
        if (frozen) throw new Error("store frozen");
        subject.store.predicate = value;
      },
    });
    const lease = acquire(subject.host);
    const wrapper = subject.store.predicate;
    frozen = true;
    expect(() => lease.release()).not.toThrow();
    expect(subject.store.predicate).toBe(wrapper);
    expect(wrapper?.()).toBe(false);
    expect(original).toHaveBeenCalledOnce();
    expect(acquireModalKeyboardGuard(subject.host).status).toBe("unavailable");
    expect(subject.store.predicate).toBe(wrapper);
    expect(original).toHaveBeenCalledOnce();
    frozen = false;
    subject.constructor.maskeditor_is_opended = original;
    acquire(subject.host).release();
    expect(subject.store.predicate).toBe(original);
  });
});
