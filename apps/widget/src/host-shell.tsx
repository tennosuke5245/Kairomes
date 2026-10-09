import { ArrowLeftIcon, FileTextIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { moveTab, type ViewTabState } from "./host-model.ts";
import { iconProps } from "./ui-icons.tsx";

// Presentational pieces of the ChatGPT host viewer (design spec §5.3 G6). State and bridge
// calls stay in main.tsx; nothing here can approve, mount or grant. The chat composer is
// gone (§5.3): ChatGPT's own composer sits right below the card.

export const viewTabId = (panelId: string, tab: string) => `${panelId}-tab-${tab}`;

/**
 * Toolbar views as WAI-ARIA tabs with manual activation: 檔案／變更／命令／終端機 in the host
 * viewer, 動態／檔案／變更／命令／終端機 in the wide workbench. A muted tab stays focusable and
 * visible (aria-disabled), shows a lock so the state never rests on colour alone, and says
 * why in its title and in screen-reader text.
 */
export function ViewTabs<T extends string>({
  tabs,
  current,
  panelId,
  className,
  onSelect,
}: {
  tabs: readonly ViewTabState<T>[];
  current: T;
  panelId: string;
  className: string;
  onSelect(tab: T): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={list}
      className={`k-tabs ${className}`}
      role="tablist"
      aria-label="工作台檢視"
      onKeyDown={(event) => {
        const buttons = [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
        const index = buttons.indexOf(event.target as HTMLElement);
        const next = index < 0 ? undefined : moveTab(event.key, index, buttons.length);
        if (next === undefined) return;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={viewTabId(panelId, tab.id)}
          type="button"
          role="tab"
          className="k-tab"
          aria-selected={tab.id === current}
          aria-controls={panelId}
          aria-disabled={tab.disabledReason ? true : undefined}
          title={tab.disabledReason}
          tabIndex={tab.id === current ? 0 : -1}
          onClick={() => {
            if (!tab.disabledReason && tab.id !== current) onSelect(tab.id);
          }}
        >
          {tab.disabledReason && <LockSimpleIcon {...iconProps("sm")} />}
          {tab.label}
          {tab.disabledReason && <span className="k-sr-only">（{tab.disabledReason}）</span>}
        </button>
      ))}
    </div>
  );
}

/** Back to the folder list when a file or image covers it (narrow host viewer only). */
export function HostBack({ label, onBack }: { label: string; onBack(): void }) {
  return (
    <div className="wb-subbar hv-back">
      <button type="button" className="k-btn k-btn--quiet k-btn--sm wb-back" onClick={onBack}>
        <ArrowLeftIcon {...iconProps("md")} />
        {label}
      </button>
    </div>
  );
}

/** The wide viewer's right pane before a file is chosen: one line, no action to repeat. */
export function HostEmptyDetail({ hasProject }: { hasProject: boolean }) {
  return (
    <div className="k-empty hv-empty">
      <span className="k-empty__icon" aria-hidden="true">
        <FileTextIcon {...iconProps("xl")} />
      </span>
      <p className="k-empty__title">{hasProject ? "從左側選擇檔案" : "還沒有專案"}</p>
      {!hasProject && <p className="k-empty__text">請先在 Kairomes Desktop 加入專案。</p>}
    </div>
  );
}
