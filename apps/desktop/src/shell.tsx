import {
  CaretRight,
  Folder,
  House,
  Lifebuoy,
  type Icon as PhosphorIcon,
  Plug,
  WarningCircle,
} from "@phosphor-icons/react";
import { Icon, KMark } from "./components.tsx";
import type { DesktopView } from "./model.ts";

export type Route = "overview" | "projects" | "connection" | "diagnostics";

const NAV: { route: Route; label: string; icon: PhosphorIcon }[] = [
  { route: "overview", label: "總覽", icon: House },
  { route: "projects", label: "專案", icon: Folder },
  { route: "connection", label: "連線設定", icon: Plug },
  { route: "diagnostics", label: "疑難排解", icon: Lifebuoy },
];

export const PAGE_TITLES: Record<Route, string> = {
  overview: "總覽",
  projects: "專案",
  connection: "連線設定",
  diagnostics: "疑難排解",
};

/**
 * The connection status chip: the only place Desktop states the connection. Before the first
 * snapshot it is a neutral placeholder, never a setup prompt.
 */
function StatusChip({ view, onOpen }: { view: DesktopView | null; onOpen: () => void }) {
  if (!view)
    return (
      <div className="desk-chip" aria-hidden="true">
        <span className="k-skeleton desk-chip__skeleton" />
      </div>
    );
  const danger = view.tone === "danger";
  return (
    <button
      className="desk-chip"
      type="button"
      data-tone={danger ? "danger" : undefined}
      onClick={onOpen}
    >
      {danger ? (
        <Icon icon={WarningCircle} />
      ) : (
        <span
          className="k-dot"
          data-tone={view.tone === "neutral" ? undefined : view.tone}
          data-pulse={view.tone === "running" ? "" : undefined}
        />
      )}
      <span className="desk-chip__label">{view.chip}</span>
      <span className="k-sr-only">，開啟連線設定</span>
      <Icon icon={CaretRight} size="sm" />
    </button>
  );
}

export function Sidebar({
  route,
  onNavigate,
  projectCount,
  view,
  version,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  /** Null until the first snapshot names the projects. */
  projectCount: number | null;
  view: DesktopView | null;
  version: string;
}) {
  return (
    <aside className="desk-side">
      <div className="desk-brand">
        <KMark />
        Kairomes
      </div>
      <nav className="desk-nav" aria-label="主要導覽">
        {NAV.map((item) => {
          const current = route === item.route;
          return (
            <button
              key={item.route}
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => onNavigate(item.route)}
            >
              <Icon icon={item.icon} size="lg" weight={current ? "fill" : "regular"} />
              {item.label}
              {item.route === "projects" && projectCount !== null ? (
                <span className="desk-nav__count">
                  {projectCount}
                  <span className="k-sr-only"> 個</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <div className="desk-foot">
        <StatusChip view={view} onOpen={() => onNavigate("connection")} />
        <p className="k-sr-only" role="status">
          {view?.chip ?? ""}
        </p>
        <p className="desk-ver">Kairomes {version}</p>
      </div>
    </aside>
  );
}
