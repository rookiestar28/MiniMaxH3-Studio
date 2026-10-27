import { createRoot } from "react-dom/client";
import { H3Sidebar } from "../src/components/H3Sidebar";
import { createSidebarWidthController } from "../src/host/sidebarWidth";
import { initialShellState } from "../src/state/shellState";
import "../src/styles/tokens.css";

const query = new URLSearchParams(location.search);
if (query.get("host") !== "none") document.body.classList.add("litegraph");
if (query.get("darkClass") === "1")
  document.documentElement.classList.add("dark-theme");
document.documentElement.style.colorScheme = query.get("scheme") ?? "";
const surface = document.getElementById("surface")!;
if (query.get("shape") === "prime") {
  surface.className = "p-splitter";
  surface.dataset.pcName = "splitter";
}
if (query.get("shape") === "unknown") {
  document.getElementById("canvas")!.remove();
  document.getElementById("opposite")!.remove();
  surface.style.width = "620px";
}
if (query.get("layout") === "continuous") {
  surface.classList.add("continuous");
  const main = document.createElement("div");
  main.id = "main";
  main.append(document.getElementById("canvas")!);
  document.getElementById("opposite")!.remove();
  surface.append(main);
}
const mount = document.getElementById("root")!;
const root = createRoot(mount);
root.render(<H3Sidebar state={initialShellState} locale="en" />);
const disposeWidth = createSidebarWidthController(mount);
Object.assign(window, {
  disposeAppearance() {
    root.unmount();
    disposeWidth();
  },
});
