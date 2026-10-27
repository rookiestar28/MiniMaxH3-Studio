// IMPORTANT: every owned .h3c root, including body portals, needs this lifecycle controller;
// the resolved light selector cannot reach an unwired root, which would stay dark on light hosts.
/** Follow host palette signals without taking ownership of harness overrides. */
export function createHostThemeController(root: HTMLElement): () => void {
  const document = root.ownerDocument;
  const html = document.documentElement;
  const attribute = "data-h3-host-theme";
  const original = root.getAttribute(attribute);
  let active = true;
  const apply = (): void => {
    if (!active) return;
    // IMPORTANT: old hosts signal dark with .dark-theme; newer hosts only set color-scheme.
    // Testing class absence alone turns every newer dark host light. Ambiguous/no host signals
    // must retain the hermetic dark default; data-theme remains a separate harness override.
    // body.litegraph is a static index.html marker, not a live signal; observe only html class/style.
    const scheme = document.defaultView?.getComputedStyle(html).colorScheme;
    const theme = html.classList.contains("dark-theme")
      ? "dark"
      : scheme === "light" || scheme === "dark"
        ? scheme
        : document.body.classList.contains("litegraph")
          ? "light"
          : undefined;
    if (theme === undefined) root.removeAttribute(attribute);
    else root.setAttribute(attribute, theme);
  };
  const observer = new MutationObserver(apply);
  observer.observe(html, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  apply();
  return () => {
    if (!active) return;
    active = false;
    observer.disconnect();
    if (original === null) root.removeAttribute(attribute);
    else root.setAttribute(attribute, original);
  };
}
