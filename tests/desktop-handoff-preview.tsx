import { createRoot } from "react-dom/client";
import { App } from "../apps/desktop/src/App.tsx";
import { createDesktopHandoffApi } from "./desktop-handoff-api.ts";

// Real App and API wrappers, replaced only at the in-memory Tauri invoke boundary.
// The preview server serves GET HTML; this fixture never sends API requests.
if (
  location.protocol !== "http:" ||
  location.hostname !== "127.0.0.1" ||
  "__TAURI_INTERNALS__" in window
)
  throw new Error("Desktop fixture requires a standalone loopback browser page.");
const fixture = createDesktopHandoffApi();
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  configurable: true,
  value: { invoke: fixture.invoke },
});

const controls = document.createElement("aside");
controls.setAttribute("aria-label", "Desktop 純合成測試控制");
controls.style.cssText =
  "position:fixed;right:6px;bottom:6px;z-index:500;padding:6px;background:white;border:1px solid #ccc;font-size:14px";
const details = document.createElement("details");
const summary = document.createElement("summary");
summary.textContent = "Desktop 合成測試";
details.append(summary);
for (const [mode, label] of [
  ["unmounted", "外部解除掛載"],
  ["offline", "工作台離線"],
  ["poll-error", "狀態回應失敗"],
  ["ready", "恢復本機"],
] as const) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.desktopFixtureMode = mode;
  button.textContent = label;
  button.addEventListener("click", () => fixture.setMode(mode));
  details.append(button);
}
const observer = document.createElement("output");
observer.id = "desktop-handoff-probe";
observer.setAttribute("aria-live", "polite");
observer.style.display = "block";
details.append(observer);
controls.append(details);
document.body.append(controls);

let probe = { mode: "ready", cancelCount: 0, activeDrafts: 0, statusReads: 0 };
const showProbe = () => {
  const focusId = document.activeElement?.id || document.activeElement?.tagName || "";
  observer.dataset.mode = probe.mode;
  observer.dataset.cancelCount = String(probe.cancelCount);
  observer.dataset.activeDrafts = String(probe.activeDrafts);
  observer.dataset.statusReads = String(probe.statusReads);
  observer.dataset.focus = focusId;
  observer.textContent = `取消 ${probe.cancelCount} · 草稿 ${probe.activeDrafts} · 焦點 ${focusId}`;
};
fixture.subscribe((next) => {
  probe = next;
  showProbe();
});
document.addEventListener("focusin", showProbe);

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Missing Desktop fixture root");
createRoot(root).render(<App />);
