// Browser API substitute for the synthetic coordinator fixture only.
// It does not call Chrome, request permissions or persist a real credential.
let stored: Record<string, unknown> = {
  kairomesPanel: {
    instanceId: "00000000-0000-4000-8000-000000000050",
    origin: location.origin,
    panelToken: "0".repeat(64),
    workbenchUrl: `${location.origin}/#session=${"0".repeat(64)}`,
  },
};
// This public synthetic adapter preserves only its fake panel state across reload.
// Native Extension storage is not used or inspected.
const sessionKey = "kairomes-synthetic-panel-session";
const saved = sessionStorage.getItem(sessionKey);
if (saved) {
  try {
    const value: unknown = JSON.parse(saved);
    if (value && typeof value === "object" && !Array.isArray(value))
      stored = value as Record<string, unknown>;
  } catch {
    /* An invalid synthetic record starts from the fixed fixture. */
  }
}
const persist = () => sessionStorage.setItem(sessionKey, JSON.stringify(stored));
export const browser = {
  runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  sidePanel: { async setPanelBehavior() {} },
  permissions: {
    async request() {
      return false;
    },
    async contains() {
      return true;
    },
  },
  storage: {
    session: {
      async get(key: string) {
        return { [key]: stored[key] };
      },
      async set(values: Record<string, unknown>) {
        stored = { ...stored, ...values };
        persist();
      },
      async remove(key: string) {
        delete stored[key];
        persist();
      },
      async setAccessLevel() {},
    },
  },
};
