import { iconSpriteId, type UiStateIcon } from "@kairomes/protocol/ui-state";

/**
 * Phosphor 2.1.10 icons used by the side panel. scripts/build-extension.ts renders exactly
 * this list (regular weight, plus the `fill` list) into the static sprite inlined into
 * sidepanel.html, so the panel needs no icon font, runtime dependency or inline style.
 */
export const PANEL_ICONS = [
  "ArrowClockwise",
  "ArrowLeft",
  "ArrowSquareOut",
  "ArrowUDownLeft",
  "ArrowsClockwise",
  "Broadcast",
  "CaretDown",
  "CaretUpDown",
  "ChatCircleDots",
  "Check",
  "CheckCircle",
  "CircleNotch",
  "ClockCountdown",
  "Copy",
  "Desktop",
  "Eye",
  "Folder",
  "GearSix",
  "Globe",
  "HardDrives",
  "Image",
  "Info",
  "Lightning",
  "LockKey",
  "MagnifyingGlass",
  "MinusCircle",
  "PencilSimple",
  "Plug",
  "Plus",
  "Prohibit",
  "Question",
  "ShieldCheck",
  "ShieldWarning",
  "SignIn",
  "SignOut",
  "Stack",
  "Stop",
  "Terminal",
  "TerminalWindow",
  "Timer",
  "Trash",
  "Tray",
  "Warning",
  "WarningCircle",
  "X",
  "XCircle",
] as const;

/** Filled weight only for an active or selected state (spec §6). */
export const PANEL_FILL_ICONS = ["GearSix", "Lightning", "ShieldWarning"] as const;

export type PanelIcon = (typeof PANEL_ICONS)[number];
export type PanelFillIcon = (typeof PANEL_FILL_ICONS)[number];

// Every protocol state icon (toneFor) must be renderable from the sprite.
type MissingStateIcon = Exclude<Exclude<UiStateIcon, "Dot">, PanelIcon>;
const stateIconsCovered: [MissingStateIcon] extends [never] ? true : MissingStateIcon = true;
void stateIconsCovered;

/** Sprite symbol id, using the same naming rule as @kairomes/protocol (GearSix → ph-gear-six). */
export function spriteId(name: PanelIcon, fill = false) {
  // iconSpriteId only rewrites the PascalCase component name, so it applies to every icon.
  const id = iconSpriteId(name as Exclude<UiStateIcon, "Dot">);
  return fill ? `${id}-fill` : id;
}

const SVG = "http://www.w3.org/2000/svg";

export interface IconOptions {
  size?: "sm" | "lg" | "xl" | "2xl";
  /** Filled weight; only icons in PANEL_FILL_ICONS have one. */
  fill?: boolean;
  /** Accessible name when the icon is the only content; otherwise it is hidden. */
  label?: string;
  spin?: boolean;
  className?: string;
}

/** `<svg class="k-icon"><use href="#ph-…"/></svg>`, built without innerHTML. */
export function icon(name: PanelIcon, options: IconOptions = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute(
    "class",
    ["k-icon", options.spin ? "k-spin" : "", options.className ?? ""].filter(Boolean).join(" "),
  );
  if (options.size) svg.setAttribute("data-size", options.size);
  if (options.label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", options.label);
  } else svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG, "use");
  const fill = options.fill === true && (PANEL_FILL_ICONS as readonly string[]).includes(name);
  use.setAttribute("href", `#${spriteId(name, fill)}`);
  svg.append(use);
  return svg;
}

/** Points an existing icon at another symbol without rebuilding it. */
export function setIcon(svg: SVGSVGElement, name: PanelIcon, fill = false) {
  const use = svg.querySelector("use");
  const href = `#${spriteId(name, fill && (PANEL_FILL_ICONS as readonly string[]).includes(name))}`;
  if (use && use.getAttribute("href") !== href) use.setAttribute("href", href);
}
