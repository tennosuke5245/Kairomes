// Copy actions (C10). navigator.clipboard.writeText runs inside the click handler, so it is
// part of the user gesture; when the host blocks it (an iframe without clipboard-write), a
// temporary selection with execCommand("copy") is the fallback. Terminal OSC 52 stays
// blocked: nothing but an explicit button press writes the clipboard.

export interface CopyEnvironment {
  clipboard?: { writeText(text: string): Promise<void> };
  /** Selection-based copy; returns whether the browser reported success. */
  selectionCopy?(text: string): boolean;
}

export async function copyText(text: string, env: CopyEnvironment = browserCopy()) {
  try {
    if (env.clipboard) {
      await env.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission policy or focus rules; try the selection fallback below.
  }
  try {
    return env.selectionCopy?.(text) ?? false;
  } catch {
    return false;
  }
}

export function browserCopy(): CopyEnvironment {
  return {
    clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
    selectionCopy(text) {
      const previous =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const area = document.createElement("textarea");
      area.value = text;
      area.readOnly = true;
      area.setAttribute("aria-hidden", "true");
      area.className = "k-sr-only";
      document.body.append(area);
      area.select();
      try {
        return document.execCommand("copy");
      } finally {
        area.remove();
        previous?.focus();
      }
    },
  };
}

export type CopyState = "idle" | "copied" | "failed";

/** Announced once through a polite live region next to the button. */
export function copyAnnouncement(state: CopyState) {
  return state === "copied" ? "已複製" : state === "failed" ? "無法複製，請手動選取" : "";
}
