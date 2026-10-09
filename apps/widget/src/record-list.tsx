import { ArrowLeftIcon, TimerIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { type MetaItem, MetaItems } from "./detail-parts.tsx";
import { isEditableTarget } from "./follow-model.ts";
import { listMove, movedIndex, rovingIndex } from "./keyboard.ts";
import type { RecordRow } from "./record-model.ts";
import { iconProps, KindTile, StatePill } from "./ui-icons.tsx";

/** What a row shows; timeline rows and command, change and terminal records share it. */
export type RowContent = Pick<
  RecordRow,
  "icon" | "verb" | "code" | "title" | "state" | "time" | "workspace" | "meta" | "reason"
> & {
  /** A directory shown first in the meta line (mono), for path rows. */
  directory?: string;
};

export function RowBody({ row }: { row: RowContent }) {
  const meta: MetaItem[] = [
    row.directory && {
      key: "dir",
      node: (
        <span className="k-mono wb-row-dir" title={row.directory}>
          {row.directory}
        </span>
      ),
      className: "wb-mi--dir",
    },
    row.time && { key: "time", node: <span>{row.time}</span> },
    row.workspace && {
      key: "workspace",
      node: (
        <span className="k-tag" data-ws={row.workspace.hue} title={row.workspace.name}>
          <span>{row.workspace.name}</span>
        </span>
      ),
      className: "wb-mi--tag",
    },
    row.meta && {
      key: "meta",
      node:
        row.meta.kind === "countdown" ? (
          <span className="k-countdown" data-urgency={row.meta.urgency}>
            <TimerIcon {...iconProps("sm")} />
            {row.meta.text}
          </span>
        ) : (
          <span className="k-num">{row.meta.text}</span>
        ),
    },
  ];
  return (
    <>
      <KindTile icon={row.icon} className="k-row__lead" />
      <span className="k-row__title" title={row.title}>
        {row.verb}
        {row.verb && row.code ? " " : null}
        {row.code && <span className="k-mono">{row.code}</span>}
      </span>
      <span className="k-row__trail">
        <StatePill state={row.state} />
      </span>
      <span className="k-row__meta">
        <MetaItems items={meta} />
      </span>
      {row.reason && (
        <span className="k-row__reason wb-reason" data-tone={row.state.dataTone}>
          {row.reason}
        </span>
      )}
    </>
  );
}

const ROVING = "[data-roving-item]";

/**
 * Roving tabindex for a list of row buttons (C9): one tab stop, ↑/↓ or j/k, Home and End.
 * Tabindex is kept in the DOM so React re-renders never add extra tab stops.
 */
export function useRovingList(container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const items = [...(container.current?.querySelectorAll<HTMLElement>(ROVING) ?? [])];
    const index = rovingIndex(
      items.map((item) => ({
        active: item.dataset.rovingActive === "true",
        current: item.getAttribute("aria-current") === "true",
      })),
    );
    items.forEach((item, position) => {
      item.tabIndex = position === index ? 0 : -1;
    });
  });
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const move = listMove({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        editable: isEditableTarget(target),
      });
      if (!move) return;
      const items = [...(container.current?.querySelectorAll<HTMLElement>(ROVING) ?? [])];
      const index = items.indexOf(target);
      if (index < 0) return;
      const next = items[movedIndex(move, index, items.length)];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      for (const item of items) {
        item.tabIndex = item === next ? 0 : -1;
        if (item === next) item.dataset.rovingActive = "true";
        else delete item.dataset.rovingActive;
      }
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
    },
    [container],
  );
}

export interface RecordListItem {
  id: string;
  row: RowContent;
}

/** A `.k-list` of whole-row buttons: title, one meta line and a tone pill (C6). */
export function RecordList({
  label,
  items,
  currentId,
  onOpen,
}: {
  label: string;
  items: readonly RecordListItem[];
  currentId?: string;
  onOpen(id: string): void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const onKeyDown = useRovingList(list);
  return (
    <ul ref={list} className="k-list k-card wb-records" aria-label={label} onKeyDown={onKeyDown}>
      {items.map(({ id, row }) => (
        <li key={id}>
          <button
            type="button"
            className="k-row"
            data-roving-item=""
            data-record-id={id}
            aria-current={id === currentId ? "true" : undefined}
            onClick={() => onOpen(id)}
          >
            <RowBody row={row} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The way back from a record opened from a panel's own list. */
export interface SubBack {
  label: string;
  back(): void;
}

/** Back from a record opened in this panel's own list, where no inspector heading exists. */
export function SubBar({
  label,
  onBack,
  buttonRef,
  children,
}: {
  label: string;
  onBack(): void;
  buttonRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  return (
    <div className="wb-subbar">
      <button
        ref={buttonRef}
        type="button"
        className="k-btn k-btn--quiet k-btn--sm wb-back"
        onClick={onBack}
      >
        <ArrowLeftIcon {...iconProps("md")} />
        {label}
      </button>
      {children}
    </div>
  );
}

/**
 * A record opened from a panel's own list (C9): one back control, labelled with where it
 * goes. With `onSubBack` the inspector heading becomes that control (the workbench);
 * otherwise the panel shows a sub-bar (the host viewer). Focus moves to the back control on
 * open and returns to the originating row on the way back, never to <body>.
 */
export function useListReturn({
  open,
  label,
  back,
  onSubBack,
}: {
  /** A record opened from the list is on screen. */
  open: boolean;
  label: string;
  /** Shows the list again. */
  back(): void;
  onSubBack?(value: SubBack | undefined): void;
}) {
  const container = useRef<HTMLElement>(null);
  const subBarButton = useRef<HTMLButtonElement>(null);
  const returnRow = useRef<string | undefined>(undefined);
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    if (!open || !onSubBack) return;
    onSubBack({ label, back: () => backRef.current() });
    return () => onSubBack(undefined);
  }, [open, label, onSubBack]);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    if (open) {
      if (!onSubBack) subBarButton.current?.focus();
      return;
    }
    const id = returnRow.current;
    returnRow.current = undefined;
    const rows = container.current?.querySelectorAll<HTMLElement>("[data-record-id]");
    [...(rows ?? [])].find((row) => row.dataset.recordId === id)?.focus();
  }, [open, onSubBack]);
  return {
    container,
    subBarButton,
    /** Remembers the row a record was opened from. */
    opened(id: string) {
      returnRow.current = id;
    },
    /** The sub-bar, only where no inspector heading takes its place. */
    subBar: open && !onSubBack ? { label, onBack: back, buttonRef: subBarButton } : undefined,
  };
}
