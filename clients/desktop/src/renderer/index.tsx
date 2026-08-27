import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./composition/DesktopApp.js";
import { initTerminalRendererKind } from "./terminal/renderer-kind.js";
import "../app.css";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("desktop root is missing");

void initTerminalRendererKind().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <DesktopApp />
    </StrictMode>,
  );
});
