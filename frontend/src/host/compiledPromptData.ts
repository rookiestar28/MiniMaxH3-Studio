const MAX_DATA_DEPTH = 64;
const MAX_DATA_MEMBERS = 100_000;
const UNSAFE_DATA_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function refuse(): never {
  throw new TypeError("unsupported compiled prompt data");
}

function copyPlainData(value: unknown): unknown {
  let members = 0;
  const copies = new Map<object, object>();
  const active = new Set<object>();

  function copy(value: unknown, depth: number): unknown {
    members += 1;
    if (depth > MAX_DATA_DEPTH || members > MAX_DATA_MEMBERS) return refuse();
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : refuse();
    if (typeof value !== "object") return refuse();
    if (active.has(value)) return refuse();
    const previous = copies.get(value);
    if (previous !== undefined) return previous;

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return refuse();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_DATA_MEMBERS) return refuse();
    const target: object = array ? [] : Object.create(prototype);
    copies.set(value, target);
    active.add(value);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, "length");
        if (
          length === undefined ||
          !("value" in length) ||
          !Number.isSafeInteger(length.value) ||
          length.value < 0 ||
          keys.length !== length.value + 1
        )
          return refuse();
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)
          )
            return refuse();
          Object.defineProperty(target, String(index), {
            value: copy(descriptor.value, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      } else {
        for (const key of keys) {
          if (typeof key !== "string" || UNSAFE_DATA_KEYS.has(key))
            return refuse();
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)
          )
            return refuse();
          Object.defineProperty(target, key, {
            value: copy(descriptor.value, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return target;
    } finally {
      active.delete(value);
    }
  }

  return copy(value, 0);
}

/** Copy data only after its containing structuredClone attempt has failed. */
export function copyCompiledPromptData<T>(value: T): T | undefined {
  try {
    return copyPlainData(value) as T;
  } catch {
    return undefined;
  }
}

/** Isolate compiled data without changing any previously successful clone. */
export function cloneCompiledPromptData<T>(value: T): T | undefined {
  try {
    return structuredClone(value);
  } catch {
    // CRITICAL: native object widgets can be reactive proxies, which structuredClone rejects.
    // Keep the data copier as fallback so accepted host values retain their existing semantics;
    // never use JSON here, which could discard non-data and falsify the prompt identity.
    return copyCompiledPromptData(value);
  }
}
