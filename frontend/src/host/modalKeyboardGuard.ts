import { seamReady, seamUnavailable, type SeamResult } from "./hostSeams";

export type ModalKeyboardGuardLease = Readonly<{
  tier: "data" | "accessor" | "absent";
  release(): void;
}>;
type Hook = ((...args: unknown[]) => unknown) | null;
type Entry = {
  count: number;
  original: PropertyDescriptor;
  latest: Hook;
  get(): Hook;
  set(value: unknown): void;
};
const entries = new WeakMap<object, Entry>();
type AccessorEntry = {
  count: number;
  original: PropertyDescriptor;
  saved: Hook;
  wrapper: (...args: unknown[]) => unknown;
};
const accessorEntries = new WeakMap<object, AccessorEntry>();
const issuedWrappers = new WeakMap<
  (...args: unknown[]) => unknown,
  { count: number }
>();
const member = "maskeditor_is_opended";
const refuse = () => seamUnavailable("modal_keyboard_guard_unavailable");
const isHook = (value: unknown): value is Hook =>
  value === null || typeof value === "function";

function constructorOf(host: unknown): object | null {
  let current = host;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function")
    )
      return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(current, "constructor");
    if (descriptor !== undefined)
      return "value" in descriptor && typeof descriptor.value === "function"
        ? (descriptor.value as object)
        : null;
    current = Reflect.getPrototypeOf(current);
  }
  return null;
}

function owns(
  descriptor: PropertyDescriptor | undefined,
  entry: Entry,
): boolean {
  return (
    descriptor?.get === entry.get &&
    descriptor.set === entry.set &&
    descriptor.enumerable === entry.original.enumerable
  );
}

type Admission = {
  constructor: object;
  tier: ModalKeyboardGuardLease["tier"];
  descriptor: PropertyDescriptor | undefined;
};

function accessorOwns(
  descriptor: PropertyDescriptor | undefined,
  original: PropertyDescriptor,
): boolean {
  return descriptor?.get === original.get && descriptor?.set === original.set;
}

function admitted(host: unknown): Admission | null {
  const constructor = constructorOf(host);
  if (constructor === null) return null;
  const descriptor = Reflect.getOwnPropertyDescriptor(constructor, member);
  const entry = entries.get(constructor);
  // IMPORTANT: keep identity after a failed restore. An inactive owned trap/value is
  // not host state: dropping it on every release re-admits frozen traps or chains wrappers.
  if (entry?.count === 0 && accessorOwns(descriptor, entry)) return null;
  if (entry !== undefined && entry.count > 0)
    return owns(descriptor, entry) && descriptor?.configurable === true
      ? { constructor, tier: "data", descriptor }
      : null;
  const accessor = accessorEntries.get(constructor);
  if (accessor !== undefined && accessor.count > 0)
    return accessorOwns(descriptor, accessor.original) &&
      descriptor?.configurable === accessor.original.configurable &&
      descriptor?.enumerable === accessor.original.enumerable
      ? { constructor, tier: "accessor", descriptor }
      : null;
  if (
    descriptor !== undefined &&
    "value" in descriptor &&
    isHook(descriptor.value) &&
    inactiveWrapper(descriptor.value)
  )
    return null;
  if (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.configurable === true &&
    descriptor.writable === true &&
    isHook(descriptor.value)
  )
    return { constructor, tier: "data", descriptor };
  // IMPORTANT: the host accessor feeds the store that changeTracker reads directly.
  // Write through its setter; redefining this member would leak canvas undo/redo.
  if (
    typeof descriptor?.get === "function" &&
    typeof descriptor.set === "function"
  )
    return { constructor, tier: "accessor", descriptor };
  // The host also contains rendered aria-modal dialogs. Unknown predicates must not
  // block mounting; the independent canvas keyboard guard remains mandatory.
  return { constructor, tier: "absent", descriptor };
}

/** Read-only shape admission; the returned factory re-probes the current host. */
export function probeModalKeyboardGuard(
  host: unknown,
): SeamResult<() => SeamResult<ModalKeyboardGuardLease>> {
  try {
    return admitted(host) === null
      ? refuse()
      : seamReady(() => acquireModalKeyboardGuard(host));
  } catch {
    return refuse();
  }
}

function restore(constructor: object, entry: Entry): void {
  try {
    const current = Reflect.getOwnPropertyDescriptor(constructor, member);
    if (owns(current, entry) && current?.configurable === true)
      Reflect.defineProperty(constructor, member, {
        ...entry.original,
        value: entry.latest,
      });
  } catch {
    // An external immutable replacement must never be overwritten during teardown.
  }
}

function noPredicate(): SeamResult<ModalKeyboardGuardLease> {
  return seamReady(Object.freeze({ tier: "absent" as const, release() {} }));
}

function inactiveWrapper(value: Hook): boolean {
  return typeof value === "function" && issuedWrappers.get(value)?.count === 0;
}

function retireData(constructor: object, entry: Entry): void {
  restore(constructor, entry);
  try {
    if (
      accessorOwns(Reflect.getOwnPropertyDescriptor(constructor, member), entry)
    )
      entries.set(constructor, entry);
    else entries.delete(constructor);
  } catch {
    entries.set(constructor, entry);
  }
}

function acquireAccessor(
  constructor: object,
  original: PropertyDescriptor,
): SeamResult<ModalKeyboardGuardLease> {
  let entry = accessorEntries.get(constructor);
  if (entry !== undefined && entry.count > 0) {
    if (Reflect.get(constructor, member) !== entry.wrapper) return refuse();
    entry.count += 1;
  } else {
    const saved: unknown = Reflect.get(constructor, member);
    if (!isHook(saved)) return noPredicate();
    if (inactiveWrapper(saved)) return refuse();
    const created: AccessorEntry = {
      count: 1,
      original,
      saved,
      // Delegate to the saved hook, never a later wrapper that may call us itself.
      wrapper: (...args) =>
        created.count > 0
          ? true
          : saved === null
            ? false
            : Reflect.apply(saved, constructor, args),
    };
    issuedWrappers.set(created.wrapper, created);
    try {
      if (
        !Reflect.set(constructor, member, created.wrapper) ||
        Reflect.get(constructor, member) !== created.wrapper
      )
        throw new TypeError(
          "Host modal predicate installation is inconsistent",
        );
      // IMPORTANT: value identity alone misses a setter/readback getter freezing or
      // replacing its own descriptor. Refuse before handing out a live lease.
      const installed = Reflect.getOwnPropertyDescriptor(constructor, member);
      if (
        !accessorOwns(installed, original) ||
        installed?.configurable !== original.configurable ||
        installed?.enumerable !== original.enumerable
      )
        throw new TypeError(
          "Host modal predicate descriptor changed during installation",
        );
    } catch {
      created.count = 0;
      try {
        if (
          accessorOwns(
            Reflect.getOwnPropertyDescriptor(constructor, member),
            original,
          )
        )
          Reflect.set(constructor, member, saved);
      } catch {
        // A throwing compatibility setter can only be restored best-effort.
      }
      return refuse();
    }
    entry = created;
    accessorEntries.set(constructor, entry);
  }
  const ownedEntry = entry;
  let released = false;
  return seamReady(
    Object.freeze({
      tier: "accessor" as const,
      release() {
        if (released) return;
        released = true;
        ownedEntry.count -= 1;
        if (ownedEntry.count !== 0) return;
        try {
          if (
            accessorOwns(
              Reflect.getOwnPropertyDescriptor(constructor, member),
              ownedEntry.original,
            ) &&
            Reflect.get(constructor, member) === ownedEntry.wrapper
          )
            Reflect.set(constructor, member, ownedEntry.saved);
        } catch {
          // Deactivated handed-out wrappers stay safe even if the host cannot restore.
        }
        accessorEntries.delete(constructor);
      },
    }),
  );
}

/** Temporarily expose the host's callable modal predicate, preserving nested consumers. */
export function acquireModalKeyboardGuard(
  host: unknown,
): SeamResult<ModalKeyboardGuardLease> {
  try {
    const admission = admitted(host);
    if (admission === null) return refuse();
    const { constructor, tier, descriptor } = admission;
    if (tier === "absent") return noPredicate();
    if (tier === "accessor") return acquireAccessor(constructor, descriptor!);
    let entry = entries.get(constructor);
    if (entry === undefined || entry.count === 0) {
      const original = Reflect.getOwnPropertyDescriptor(constructor, member)!;
      const originalHook = original.value as Hook;
      const created: Entry = {
        count: 1,
        original,
        latest: originalHook,
        get: () => (created.count > 0 ? wrapper : created.latest),
        set: (value) => {
          if (!isHook(value))
            throw new TypeError(
              "Host modal predicate must be nullable or callable",
            );
          created.latest = value;
        },
      };
      // IMPORTANT: delegate inactive handed-out wrappers to the original hook, not the latest
      // external assignment; an external wrapper may itself call this callable after release.
      const wrapper = (...args: unknown[]) =>
        created.count > 0
          ? true
          : originalHook === null
            ? false
            : Reflect.apply(originalHook, constructor, args);
      issuedWrappers.set(wrapper, created);
      let installed = false;
      try {
        installed =
          Reflect.defineProperty(constructor, member, {
            configurable: true,
            enumerable: original.enumerable,
            get: created.get,
            set: created.set,
          }) &&
          owns(Reflect.getOwnPropertyDescriptor(constructor, member), created);
      } catch {
        installed = false;
      }
      if (!installed) {
        created.count = 0;
        retireData(constructor, created);
        return refuse();
      }
      entry = created;
      entries.set(constructor, entry);
    } else entry.count += 1;
    const ownedEntry = entry;
    let released = false;
    return seamReady(
      Object.freeze({
        tier: "data" as const,
        release() {
          if (released) return;
          released = true;
          ownedEntry.count -= 1;
          if (ownedEntry.count !== 0) return;
          retireData(constructor, ownedEntry);
        },
      }),
    );
  } catch {
    return refuse();
  }
}
