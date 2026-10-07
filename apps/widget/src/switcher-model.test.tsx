import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALL_PROJECTS,
  moveActive,
  switcherLabel,
  switcherOptions,
  typeAhead,
  typeAheadCharacter,
} from "./switcher-model.ts";
import { workspaceHue } from "./timeline-model.ts";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";

const one = "10000000-0000-4000-8000-000000000001";
const two = "10000000-0000-4000-8000-000000000002";
const three = "10000000-0000-4000-8000-000000000003";
const workspaces = [
  { id: one, name: "Kairomes" },
  { id: two, name: "docs-site" },
  { id: three, name: "Kiosk" },
];

test("options start with 全部專案 and keep opaque ids; the label falls back safely", () => {
  expect(switcherOptions(workspaces).map((option) => option.id)).toEqual([null, one, two, three]);
  expect(switcherLabel(null, workspaces)).toBe(ALL_PROJECTS);
  expect(switcherLabel(two, workspaces)).toBe("docs-site");
  expect(switcherLabel("gone", workspaces, "已移除的專案")).toBe("已移除的專案");
  expect(switcherLabel("gone", workspaces)).toBe(ALL_PROJECTS);
});

test("arrow, Home and End move without wrapping; other keys are not movement", () => {
  expect(moveActive("ArrowDown", 0, 4)).toBe(1);
  expect(moveActive("ArrowDown", 3, 4)).toBe(3);
  expect(moveActive("ArrowDown", -1, 4)).toBe(0);
  expect(moveActive("ArrowUp", 0, 4)).toBe(0);
  expect(moveActive("ArrowUp", -1, 4)).toBe(3);
  expect(moveActive("Home", 2, 4)).toBe(0);
  expect(moveActive("End", 0, 4)).toBe(3);
  expect(moveActive("Enter", 0, 4)).toBeUndefined();
  expect(moveActive("ArrowDown", 0, 0)).toBe(-1);
});

test("type-ahead matches prefixes, cycles on a repeated letter and ignores misses", () => {
  const options = switcherOptions(workspaces);
  expect(typeAhead(options, "d", 0)).toBe(2);
  expect(typeAhead(options, "k", 0)).toBe(1);
  expect(typeAhead(options, "k", 1)).toBe(3);
  expect(typeAhead(options, "kk", 3)).toBe(1);
  expect(typeAhead(options, "ki", 1)).toBe(3);
  expect(typeAhead(options, "全", 2)).toBe(0);
  expect(typeAhead(options, "z", 0)).toBeUndefined();
  expect(typeAhead(options, "", 0)).toBeUndefined();
  expect(typeAheadCharacter({ key: "k" })).toBe("k");
  expect(typeAheadCharacter({ key: " " })).toBeUndefined();
  expect(typeAheadCharacter({ key: "ArrowDown" })).toBeUndefined();
  expect(typeAheadCharacter({ key: "k", ctrlKey: true })).toBeUndefined();
});

test("the closed switcher is one compact button that names its listbox popup", () => {
  const all = renderToStaticMarkup(
    <WorkspaceSwitcher workspaces={workspaces} selected={null} onSelect={() => {}} />,
  );
  expect(all).toContain('aria-haspopup="listbox"');
  expect(all).toContain('aria-expanded="false"');
  expect(all).toContain("全部專案");
  expect(all).not.toContain("<select");
  expect(all).not.toContain('role="listbox"');
  const filtered = renderToStaticMarkup(
    <WorkspaceSwitcher workspaces={workspaces} selected={two} onSelect={() => {}} />,
  );
  expect(filtered).toContain('aria-label="專案：docs-site"');
  expect(filtered).toContain(`data-ws="${workspaceHue(two)}"`);
  expect(filtered).toContain(">D</span>");
  // A filtered project that is gone and has no remembered name falls back to 全部專案.
  const gone = renderToStaticMarkup(
    <WorkspaceSwitcher workspaces={workspaces} selected="gone" onSelect={() => {}} />,
  );
  expect(gone).toContain("全部專案");
  expect(gone).not.toContain("k-avatar");
});

test("the host viewer's switcher lists projects only and asks for one when none is chosen", () => {
  expect(switcherOptions(workspaces, false).map((option) => option.id)).toEqual([one, two, three]);
  expect(switcherLabel(two, workspaces, undefined, false)).toBe("docs-site");
  expect(switcherLabel(null, workspaces, undefined, false)).toBe("選擇專案");
  expect(switcherLabel(null, [], undefined, false)).toBe("還沒有專案");
  const host = renderToStaticMarkup(
    <WorkspaceSwitcher
      workspaces={workspaces}
      selected={one}
      includeAll={false}
      onSelect={() => {}}
    />,
  );
  expect(host).toContain('aria-label="專案：Kairomes"');
  expect(host).not.toContain(ALL_PROJECTS);
  expect(host).not.toMatch(/<button[^>]*disabled/);
  // With no project there is nothing to choose, so the trigger is disabled.
  const empty = renderToStaticMarkup(
    <WorkspaceSwitcher workspaces={[]} selected={null} includeAll={false} onSelect={() => {}} />,
  );
  expect(empty).toContain("還沒有專案");
  expect(empty).toMatch(/<button[^>]*disabled/);
});
