import {
  app as host,
  fixtureModalStore,
  setFixtureModalKeyboardShape,
} from "../tests/fixtures/entryHostModules";
import type { ModalKeyboardHostShape } from "../tests/support/hostSeamTestDouble";
export { app, api } from "../tests/fixtures/entryHostModules";

let predicateShape: ModalKeyboardHostShape = "data";
export function configureHostModalPredicate(shape: ModalKeyboardHostShape) {
  predicateShape = shape;
  setFixtureModalKeyboardShape(shape);
}

export function hostModalPredicateActive(): boolean {
  const predicate =
    predicateShape === "accessor"
      ? fixtureModalStore.predicate
      : (Reflect.get(host.constructor, "maskeditor_is_opended") as
          (() => unknown) | null | undefined);
  return Boolean(predicate?.call(host.constructor));
}

/** The aria-modal branch of both supported hosts' modalUtil.isModalOpen. */
export function hostAriaModalOpen(): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
  ).some(
    (element) =>
      element.closest('[hidden], [aria-hidden="true"]') === null &&
      element.checkVisibility({ visibilityProperty: true }),
  );
}

export type HostKeyWitness = {
  undoCapture: number;
  undoActions: number;
  canvasKeyups: number;
  ghostActions: number;
};

export function installHostCapture(
  withGhost: boolean,
  changeMode = false,
): HostKeyWitness {
  const witness: HostKeyWitness = {
    undoCapture: 0,
    undoActions: 0,
    canvasKeyups: 0,
    ghostActions: 0,
  };
  // Source-compatible constructor/store readers, plus their shared DOM containment.
  // This hermetic mirror is not an installed frontend; retain only action counts.
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        !["z", "y"].includes(event.key.toLowerCase())
      )
        return;
      witness.undoCapture += 1;
      if (hostModalPredicateActive()) return;
      if (
        !changeMode &&
        (event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement)
      )
        return;
      if (hostAriaModalOpen()) return;
      witness.undoActions += 1;
    },
    true,
  );
  host.canvas._key_callback = (event) => {
    if (!(event.target instanceof HTMLInputElement)) witness.canvasKeyups += 1;
  };
  document.addEventListener("keyup", host.canvas._key_callback, true);
  if (withGhost) {
    host.canvas.state.ghostNodeId = "fixture-pending-node";
    const callback = ((event: KeyboardEvent) => {
      if (!["Escape", "Delete", "Backspace"].includes(event.key)) return;
      witness.ghostActions += 1;
      host.canvas.state.ghostNodeId = null;
      host.canvas._ghostKeyHandler = null;
      document.removeEventListener("keydown", callback, true);
      event.preventDefault();
      event.stopPropagation();
    }) as EventListener;
    host.canvas._ghostKeyHandler = callback;
    document.addEventListener("keydown", callback, true);
  }
  return witness;
}
