export {};

const abort = new AbortController();
let refreshing = false;
const output = document.querySelector<HTMLOutputElement>("#study-state");
async function observe() {
  if (refreshing || abort.signal.aborted) return;
  refreshing = true;
  try {
    const [panel, study] = await Promise.all([
      fetch("/synthetic-panel/probe", { signal: abort.signal }).then((reply) => reply.json()),
      fetch("/synthetic-study/probe", { signal: abort.signal }).then((reply) => reply.json()),
    ]);
    if (output && !abort.signal.aborted)
      output.textContent = `變更 ${panel.mutations} · 串流 ${panel.activeStreams} · 延遲 catalog ${panel.heldCatalogs} · 成果版本 ${study.widget.revision} · α ${study.alpha.scenario} · β ${study.beta.scenario}`;
  } catch {
    if (output && !abort.signal.aborted) output.textContent = "觀測失敗";
  } finally {
    refreshing = false;
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-study-action]")) {
  button.onclick = async () => {
    button.disabled = true;
    try {
      const material = button.dataset.material;
      const body =
        material === "panel"
          ? { action: button.dataset.studyAction }
          : { material, action: button.dataset.studyAction };
      const response = await fetch(
        material === "panel" ? "/synthetic-panel/control" : "/synthetic-study/control",
        {
          method: "POST",
          signal: abort.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error("Synthetic control rejected");
      await observe();
    } catch {
      if (output && !abort.signal.aborted) output.textContent = "操作失敗";
    } finally {
      button.disabled = false;
    }
  };
}
const timer = setInterval(() => void observe(), 500);
window.addEventListener(
  "pagehide",
  () => {
    clearInterval(timer);
    abort.abort();
  },
  { once: true },
);
await observe();
