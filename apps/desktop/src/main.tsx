import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// Shared tokens and components load first; the surface stylesheet builds on them.
import "@kairomes/ui-tokens/tokens.css";
import "@kairomes/ui-tokens/components.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Kairomes Desktop root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
