/** Bounded scalar counting for an already validated private sequence authority. */
export function isBoundedPrivateCanonicalPrompt(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (++count > 4096) return false;
  }
  return true;
}
