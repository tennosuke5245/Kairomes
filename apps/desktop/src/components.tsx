import {
  ChatCircleDots,
  Check,
  CheckCircle,
  CircleNotch,
  Desktop,
  Hand,
  HourglassMedium,
  type IconWeight,
  Info,
  ListChecks,
  LockKey,
  MinusCircle,
  PauseCircle,
  type Icon as PhosphorIcon,
  Question,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useState } from "react";
import type { PillIcon, RowTone } from "./checks.ts";
import { avatarLetter, workspaceHue } from "./format.ts";
import type { DesktopStatusIcon, DesktopTone, PathwayStates } from "./model.ts";
import { NOTICE_SUCCESS_MS, type Notice, noticeRole } from "./notice.ts";

type IconSize = "sm" | "lg" | "xl" | "2xl";

/** A Phosphor glyph sized by the shared `.k-icon` scale; decorative unless a label is given. */
export function Icon({
  icon: Glyph,
  size,
  weight = "regular",
  spin = false,
}: {
  icon: PhosphorIcon;
  size?: IconSize;
  weight?: IconWeight;
  spin?: boolean;
}) {
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      className={spin ? "k-icon k-spin" : "k-icon"}
      data-size={size}
      weight={weight}
    />
  );
}

/** The K mark in --k-brand-mark (same paths as app-icon.svg), so it follows the theme. */
export function KMark({ className = "k-logo" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <path d="M22 16c-6 0-10 4-10 10v76c0 6 4 10 10 10s10-4 10-10V26c0-6-4-10-10-10Z" />
      <path d="M106 16H84c-3 0-6 1-8 4L38 57c-4 4-4 10 0 14l39 37c2 3 5 4 8 4h21c4 0 7-2 8-5 1-3 0-6-2-8L73 64l38-35c3-2 4-6 2-9-1-2-4-4-7-4Z" />
    </svg>
  );
}

/**
 * Props for a button that waits while an action runs. It keeps keyboard focus: it is marked
 * aria-disabled (styled like a disabled button) and a press does nothing, where `disabled`
 * would drop focus to the page body the moment it was pressed.
 */
export function waitable(
  waiting: boolean,
  onClick: (event: MouseEvent<HTMLButtonElement>) => void,
): {
  "aria-disabled": true | undefined;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
} {
  return {
    "aria-disabled": waiting || undefined,
    onClick: (event) => {
      // A submit button must not submit either.
      if (waiting) event.preventDefault();
      else onClick(event);
    },
  };
}

/** Re-renders every `intervalMs` so countdowns and relative times stay current. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const STATUS_ICONS: Record<DesktopStatusIcon, PhosphorIcon> = {
  ListChecks,
  Hand,
  PauseCircle,
  CircleNotch,
  WarningCircle,
  CheckCircle,
};

const PILL_ICONS: Record<PillIcon, PhosphorIcon> = {
  Check,
  CircleNotch,
  WarningCircle,
  XCircle,
  PauseCircle,
  MinusCircle,
  HourglassMedium,
  Question,
};

/** A state pill: icon and label together, so colour is never the only signal. */
export function StatePill({ tone, icon, label }: { tone: RowTone; icon: PillIcon; label: string }) {
  return (
    <span className="k-pill" data-tone={tone === "neutral" ? undefined : tone}>
      <Icon icon={PILL_ICONS[icon]} size="sm" spin={icon === "CircleNotch"} />
      {label}
    </span>
  );
}

/** Kind tile tinted by state: only a component that needs the user gets a tone. */
export function StateTile({ tone, icon }: { tone: RowTone; icon: PhosphorIcon }) {
  return (
    <span className="k-kind" data-tone={tone === "danger" || tone === "warning" ? tone : undefined}>
      <Icon icon={icon} size="lg" />
    </span>
  );
}

/** Status-line lead tile: the state icon, toned for everything but setup. */
export function StatusTile({ icon, tone }: { icon: DesktopStatusIcon; tone: DesktopTone }) {
  return (
    <span className="k-kind" data-tone={tone === "neutral" ? undefined : tone}>
      <Icon icon={STATUS_ICONS[icon]} size="lg" spin={icon === "CircleNotch"} />
    </span>
  );
}

const HOPS: { label: string; icon: PhosphorIcon }[] = [
  { label: "本機", icon: Desktop },
  { label: "安全通道", icon: LockKey },
  { label: "ChatGPT", icon: ChatCircleDots },
];
const NODE_STATE_TEXT = { ok: "正常", fail: "中斷", off: "未連線" } as const;
const NODE_TONE = { ok: "success", fail: "danger", off: undefined } as const;

/** 本機 → 安全通道 → ChatGPT with the failing hop marked (error lines and 疑難排解 only). */
export function Pathway({ states }: { states: PathwayStates }) {
  const { nodes, links } = states;
  return (
    <ol className="k-pathway desk-pathway" aria-label="連線路徑">
      {HOPS.map((hop, index) => {
        const state = nodes[index] ?? "off";
        const link = index < links.length ? links[index] : null;
        return [
          <li
            key={hop.label}
            className="k-pathway__node"
            data-state={state === "ok" ? undefined : state}
          >
            <span className="k-pathway__icon">
              <Icon icon={hop.icon} size="lg" />
              <span className="k-dot" data-tone={NODE_TONE[state]} />
            </span>
            {hop.label}
            <span className="k-sr-only">：{NODE_STATE_TEXT[state]}</span>
          </li>,
          link ? (
            <li
              key={`${hop.label}-link`}
              className="k-pathway__link"
              data-state={link === "ok" ? undefined : link}
              aria-hidden="true"
            />
          ) : null,
        ];
      })}
    </ol>
  );
}

/**
 * The one notice slot. Both live regions stay mounted so screen readers hear a message the
 * moment it appears: danger goes to the alert region, everything else to the polite one.
 * Success clears itself; a repeated message keeps the same object and is not announced again.
 */
export function NoticeSlot({
  notice,
  onDismiss,
}: {
  notice: Notice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (notice?.tone !== "success") return;
    const timer = setTimeout(onDismiss, NOTICE_SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);
  const card = notice ? (
    <div
      className="k-notice desk-notice"
      data-tone={notice.tone === "neutral" ? undefined : notice.tone}
    >
      <Icon
        icon={
          notice.tone === "success" ? CheckCircle : notice.tone === "neutral" ? Info : WarningCircle
        }
        size="lg"
      />
      <div className="k-notice__body">{notice.text}</div>
      <button
        className="k-btn k-btn--quiet k-btn--icon k-btn--sm k-notice__close"
        type="button"
        aria-label="關閉訊息"
        onClick={onDismiss}
      >
        <Icon icon={X} />
      </button>
    </div>
  ) : null;
  const role = notice ? noticeRole(notice.tone) : null;
  return (
    <>
      <div role="status">{role === "status" ? card : null}</div>
      <div role="alert">{role === "alert" ? card : null}</div>
    </>
  );
}

/** Letter tile in the workspace's decorative hue; the name is always shown beside it. */
export function WorkspaceAvatar({
  id,
  name,
  large = false,
}: {
  id: string;
  name: string;
  large?: boolean;
}) {
  return (
    <span
      className={large ? "k-avatar k-avatar--lg" : "k-avatar"}
      style={{ "--ws": `var(--k-ws-${workspaceHue(id)})` } as CSSProperties}
      aria-hidden="true"
    >
      {avatarLetter(name)}
    </span>
  );
}

/** 7px hue square + name, for counts that belong to a project. */
export function WorkspaceTag({ id, name }: { id: string; name: string | null }) {
  return (
    <span className="k-tag" style={{ "--ws": `var(--k-ws-${workspaceHue(id)})` } as CSSProperties}>
      {name ?? "已移除的專案"}
    </span>
  );
}

/** A section with a title row and an optional trailing control. */
export function Section({
  id,
  title,
  trailing,
  children,
}: {
  id: string;
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="desk-section" aria-labelledby={id}>
      <div className="desk-section__head">
        <h2 className="k-section-title" id={id}>
          {title}
        </h2>
        {trailing}
      </div>
      {children}
    </section>
  );
}
