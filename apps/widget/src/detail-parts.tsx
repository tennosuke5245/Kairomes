import type { UiState } from "@kairomes/protocol/ui-state";
import { CaretRightIcon, CheckIcon, CopyIcon, HouseIcon, TrayIcon } from "@phosphor-icons/react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { argvParts, cwdLabel, type Fact, type WorkspaceCwd } from "./command-model.ts";
import { type CopyState, copyAnnouncement, copyText } from "./copy.ts";
import type { KindIcon } from "./timeline-model.ts";
import { iconProps, KindTile, StatePill } from "./ui-icons.tsx";

// Shared inspector pieces (design spec §5.3): one head (kind tile, title, one pill, one meta
// line), a stats strip, and a technical disclosure for ids and version hashes.

export type MetaItem =
  | { key: string; node: ReactNode; className?: string }
  | false
  | ""
  | undefined;

/**
 * Meta items joined with a middle dot. Each dot travels with the item after it (one
 * `.wb-mi` box), so a wrapped line never ends in a dangling `·`.
 */
export function MetaItems({ items }: { items: readonly MetaItem[] }) {
  const shown = items.filter((item): item is Exclude<MetaItem, false | "" | undefined> => !!item);
  return shown.map((item, index) => (
    <span key={item.key} className={`wb-mi ${item.className ?? ""}`.trim()}>
      {index > 0 && (
        <span className="k-sep" aria-hidden="true">
          ·
        </span>
      )}
      {item.node}
    </span>
  ));
}

/** Items joined with a middle dot; empty items are dropped. */
export function MetaLine({
  items,
  className = "insp-meta",
}: {
  items: ReactNode[];
  className?: string;
}) {
  const shown = items.filter(
    (item) => item !== undefined && item !== null && item !== false && item !== "",
  );
  if (!shown.length) return null;
  return (
    <p className={className}>
      <MetaItems items={shown.map((node, index) => ({ key: String(index), node }))} />
    </p>
  );
}

export function WorkspaceTag({ name, hue }: { name: string; hue: number }) {
  return (
    <span className="k-tag" data-ws={hue} title={name}>
      <span>{name}</span>
    </span>
  );
}

/**
 * argv as monospace elements that each wrap as a unit: a line breaks between elements,
 * never inside `--filter`, unless one element alone is wider than the line.
 */
export function ArgvText({ argv }: { argv: readonly string[] }) {
  return (
    <span className="k-mono insp-argv">
      {argvParts(argv).map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: argv is positional.
        <Fragment key={index}>
          {index > 0 && " "}
          <span className="insp-argv__item">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

export function InspectorHead({
  icon,
  verb,
  code,
  state,
  meta = [],
  actions,
}: {
  icon: KindIcon;
  verb: string;
  /** A verbatim value (path, shell); a node such as ArgvText renders as given. */
  code?: ReactNode;
  state?: UiState;
  meta?: ReactNode[];
  actions?: ReactNode;
}) {
  return (
    <header className="insp-head">
      <KindTile icon={icon} size="lg" />
      <h2 className="insp-title">
        <span className="insp-title__text">
          {verb}
          {verb && code ? " " : null}
          {typeof code === "string" ? <span className="k-mono">{code}</span> : code}
        </span>
        {state && <StatePill state={state} />}
      </h2>
      {actions && <div className="insp-actions">{actions}</div>}
      <MetaLine items={meta} />
    </header>
  );
}

/** The stats strip: exit code, duration, sizes. Danger only for a failing value. */
export function FactsStrip({ facts }: { facts: readonly Fact[] }) {
  if (!facts.length) return null;
  return (
    <dl className="k-facts insp-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd className={fact.mono ? "k-mono" : undefined} data-tone={fact.tone}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A secondary disclosure (技術資訊, 呼叫參數, 結構化結果): a caret that turns when open, like
 * the MCP result card, so the summary never reads as a plain heading.
 */
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="insp-tech">
      <summary>
        <CaretRightIcon {...iconProps("sm")} />
        {summary}
      </summary>
      {children}
    </details>
  );
}

/** Ids and version hashes, out of the way (技術資訊). Values keep their full text in title. */
export function TechDetails({ rows }: { rows: readonly [label: string, value: string][] }) {
  if (!rows.length) return null;
  return (
    <Disclosure summary="技術資訊">
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="k-mono" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}

/** A loading or empty line, never a fake content row. */
export function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p className="insp-status" role="status">
      {children}
    </p>
  );
}

/** Working directory in a meta line: 專案根目錄 with a House icon, else the relative path in mono. */
export function CwdMeta({ cwd }: { cwd: WorkspaceCwd }) {
  return cwd.kind === "path" ? (
    <span className="insp-meta__cwd k-mono" title="工作目錄">
      {cwd.path}
    </span>
  ) : (
    <span className="insp-meta__cwd" title="工作目錄">
      <HouseIcon {...iconProps("sm")} />
      {cwdLabel(cwd)}
    </span>
  );
}

/**
 * Copy inside the click (user gesture), with a selection fallback; 已複製 is announced once
 * through a polite live region (C10).
 */
export function CopyButton({
  text,
  label,
  iconOnly = false,
  className = "",
}: {
  text(): string;
  label: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const visible = state === "copied" ? "已複製" : label;
  return (
    <>
      <button
        type="button"
        className={`k-btn k-btn--quiet k-btn--sm ${iconOnly ? "k-btn--icon" : ""} ${className}`.trim()}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        onClick={() => {
          void copyText(text()).then((copied) => setState(copied ? "copied" : "failed"));
        }}
      >
        {state === "copied" ? (
          <CheckIcon {...iconProps("sm")} />
        ) : (
          <CopyIcon {...iconProps("sm")} />
        )}
        {!iconOnly && visible}
      </button>
      <span className="k-sr-only" role="status" aria-live="polite">
        {copyAnnouncement(state)}
      </span>
    </>
  );
}

/** Pending work is text-only here: approval stays in the native side panel. */
export function PendingNotice() {
  return (
    <p className="k-notice" data-tone="brand" role="status">
      <TrayIcon {...iconProps("lg")} />
      <span className="k-notice__body">
        <span className="k-notice__title">需確認</span> · 請在側欄審核
      </span>
    </p>
  );
}
