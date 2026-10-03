// Actual fetch and SSE; only Chrome APIs are replaced by the preview bundle.
export {};

// The endpoint mutates synthetic memory only, never a real host or workspace.
const probe = document.querySelector<HTMLOutputElement>("#fixture-probe");
const abort = new AbortController();
let refreshing = false;
async function observe() {
  if (!probe || refreshing || abort.signal.aborted) return;
  refreshing = true;
  try {
    const response = await fetch("/synthetic-panel/probe", { signal: abort.signal });
    const data = await response.json();
    if (probe && !abort.signal.aborted) {
      probe.textContent = `HTTP 變更 ${data.mutations} · 唯讀查詢 ${data.lists} · 串流 ${data.streams}`;
      probe.dataset.mutations = String(data.mutations);
      probe.dataset.activeStreams = String(data.activeStreams);
      probe.dataset.heldLists = String(data.heldLists);
      probe.dataset.accessMutations = String(data.accessMutations);
      probe.dataset.accessQueries = String(data.accessQueries);
      probe.dataset.heldAccess = String(data.heldAccess);
    }
  } catch {
    /* Navigation cancels a synthetic observation. */
  } finally {
    refreshing = false;
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-fixture-action]")) {
  button.onclick = async () => {
    button.disabled = true;
    try {
      await fetch("/synthetic-panel/control", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: button.dataset.fixtureAction }),
      });
      await observe();
    } catch {
      /* Navigation cancels a synthetic control request. */
    } finally {
      button.disabled = false;
    }
  };
}
const timer = probe ? setInterval(() => void observe(), 500) : undefined;
window.addEventListener(
  "pagehide",
  () => {
    clearInterval(timer);
    abort.abort();
  },
  { once: true },
);
await observe();
await import("../apps/extension/src/sidepanel.ts");
