import type { UiState, UiStateIcon } from "@kairomes/protocol/ui-state";
import {
  ArrowsClockwiseIcon,
  BroadcastIcon,
  CheckIcon,
  CircleNotchIcon,
  ClockCountdownIcon,
  FilesIcon,
  FileTextIcon,
  FolderIcon,
  GitDiffIcon,
  HardDrivesIcon,
  type Icon,
  ImageIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  MinusCircleIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SignInIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TrayIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { K_MARK_PATHS } from "./icon-paths.ts";
import type { KindIcon } from "./timeline-model.ts";

type IconSize = "sm" | "md" | "lg" | "xl" | "2xl";
const iconProps = (size: IconSize) =>
  ({
    className: "k-icon",
    "aria-hidden": true,
    ...(size === "md" ? {} : { "data-size": size }),
  }) as const;

const stateIcons: Record<Exclude<UiStateIcon, "Dot">, Icon> = {
  ArrowsClockwise: ArrowsClockwiseIcon,
  Broadcast: BroadcastIcon,
  Check: CheckIcon,
  CircleNotch: CircleNotchIcon,
  ClockCountdown: ClockCountdownIcon,
  Lightning: LightningIcon,
  MinusCircle: MinusCircleIcon,
  PencilSimple: PencilSimpleIcon,
  Prohibit: ProhibitIcon,
  Question: QuestionIcon,
  ShieldCheck: ShieldCheckIcon,
  SignIn: SignInIcon,
  TerminalWindow: TerminalWindowIcon,
  Tray: TrayIcon,
  WarningCircle: WarningCircleIcon,
  XCircle: XCircleIcon,
};

/** A status pill: icon and label together, so colour is never the only signal. */
export function StatePill({ state, large = false }: { state: UiState; large?: boolean }) {
  const StateGlyph = state.icon === "Dot" ? undefined : stateIcons[state.icon];
  return (
    <span className={large ? "k-pill k-pill--lg" : "k-pill"} data-tone={state.dataTone}>
      {StateGlyph ? (
        <StateGlyph
          {...iconProps("md")}
          className={state.spin ? "k-icon k-spin" : "k-icon"}
          weight={state.icon === "CircleNotch" ? "bold" : "regular"}
        />
      ) : (
        <span className="k-dot" data-tone={state.dataTone} />
      )}
      {state.label}
    </span>
  );
}

const kindIcons: Record<KindIcon, Icon> = {
  command: TerminalIcon,
  terminal: TerminalWindowIcon,
  file: FileTextIcon,
  files: FilesIcon,
  change: PencilSimpleIcon,
  image: ImageIcon,
  search: MagnifyingGlassIcon,
  folder: FolderIcon,
  git: GitDiffIcon,
  mcp: HardDrivesIcon,
};

/** Neutral kind tile: the list shows state once, in the pill. Large in the inspector head. */
export function KindTile({
  icon,
  className = "",
  size = "sm",
}: {
  icon: KindIcon;
  className?: string;
  size?: "sm" | "lg";
}) {
  const KindGlyph = kindIcons[icon];
  return (
    <span className={`k-kind k-kind--${size} ${className}`.trim()} aria-hidden="true">
      <KindGlyph {...iconProps(size === "lg" ? "lg" : "sm")} />
    </span>
  );
}

/** The K mark in --k-brand-mark (same paths as app-icon.svg). */
export function KMark() {
  return (
    <svg className="k-logo" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      {K_MARK_PATHS.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

export { iconProps };
