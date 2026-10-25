// Renderer entry. The renderer reaches the daemon only through `window.pm`,
// which the preload exposes; it never opens sockets or sees tokens.
import { createRoot } from "react-dom/client";
import "./pm.css";
import type { PmApi } from "../pm-api.js";
import { PmController } from "./composition/pm-controller.js";
import { PmApp } from "./composition/PmApp.js";
import { createPmStore } from "./state/presentation-store.js";

declare global {
  interface Window {
    pm: PmApi;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const controller = new PmController(window.pm, createPmStore());
createRoot(root).render(<PmApp controller={controller} terminal={window.pm.terminal} />);
