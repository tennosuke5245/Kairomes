import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CloseHintDialog,
  ConfirmDialog,
  closeOwn,
  KeyDialog,
  RenameDialog,
  wrapFocusIndex,
} from "./dialog.tsx";
import { menuIndex } from "./menu.tsx";

const noop = () => undefined;

test("a destructive confirmation names the consequence and puts 取消 before the danger button", () => {
  const markup = renderToStaticMarkup(
    <ConfirmDialog
      title="重新啟動本機服務？"
      consequence="會停止所有命令與終端機；瀏覽器側欄需重新配對。"
      confirmLabel="重新啟動"
      onConfirm={async () => undefined}
      onClose={noop}
    />,
  );
  expect(markup).toContain('<dialog class="k-dialog desk-dialog"');
  expect(markup).toContain("aria-labelledby=");
  expect(markup).toContain("aria-describedby=");
  expect(markup).toContain("會停止所有命令與終端機；瀏覽器側欄需重新配對。");
  const cancel = markup.indexOf(">取消<");
  const danger = markup.indexOf("k-btn--danger");
  expect(cancel).toBeGreaterThan(-1);
  expect(danger).toBeGreaterThan(cancel);
  expect(markup).not.toMatch(/復原|還原|恢復/);
});

test("the key dialog keeps the key masked, says where it is kept and offers one save", () => {
  const markup = renderToStaticMarkup(<KeyDialog onClose={noop} onSaved={noop} />);
  expect(markup).toContain('type="password"');
  expect(markup).toContain("交給 Windows 認證管理員保管，之後不會再顯示。");
  expect(markup.match(/k-btn--primary/g)).toHaveLength(1);
  expect(markup).toContain("儲存金鑰");
});

test("Tab wraps inside a dialog in both directions and leaves the middle alone", () => {
  expect(wrapFocusIndex(3, 2, false)).toBe(0);
  expect(wrapFocusIndex(3, 0, true)).toBe(2);
  expect(wrapFocusIndex(3, 1, false)).toBeNull();
  expect(wrapFocusIndex(3, 1, true)).toBeNull();
  // Focus outside the dialog comes back in at the matching end.
  expect(wrapFocusIndex(3, -1, false)).toBe(0);
  expect(wrapFocusIndex(3, -1, true)).toBe(2);
  expect(wrapFocusIndex(0, -1, false)).toBeNull();
});

test("the overflow menu moves with arrows, Home and End, and wraps", () => {
  expect(menuIndex("ArrowDown", -1, 4)).toBe(0);
  expect(menuIndex("ArrowDown", 3, 4)).toBe(0);
  expect(menuIndex("ArrowUp", 0, 4)).toBe(3);
  expect(menuIndex("ArrowUp", -1, 4)).toBe(3);
  expect(menuIndex("Home", 2, 4)).toBe(0);
  expect(menuIndex("End", 0, 4)).toBe(3);
  expect(menuIndex("Enter", 1, 4)).toBeNull();
  expect(menuIndex("ArrowDown", 0, 0)).toBeNull();
});

test("renaming says the folder keeps its name and saves with one ink button", () => {
  const markup = renderToStaticMarkup(
    <RenameDialog name="Athori" onClose={noop} onRename={async () => undefined} />,
  );
  expect(markup).toContain("重新命名專案");
  expect(markup).toContain('value="Athori"');
  expect(markup).toContain("只改 Kairomes 裡顯示的名稱，資料夾不會改名。");
  expect(markup.match(/k-btn--primary/g)).toHaveLength(1);
});

test("a confirmation blocked by another action says so and keeps the danger button off", () => {
  const markup = renderToStaticMarkup(
    <ConfirmDialog
      title="移除 Runtime API Key？"
      consequence="安全通道會立即中斷，直到你重新設定金鑰。"
      confirmLabel="移除金鑰"
      blocked
      onConfirm={async () => undefined}
      onClose={noop}
    />,
  );
  expect(markup).toContain("另一個操作還在進行，完成後才能繼續。");
  expect(markup).toMatch(/<button class="k-btn k-btn--danger k-btn--lg"[^>]*disabled=""/);
});

test("a dialog closes only itself, so a tray restart request survives an earlier dialog's finish", () => {
  const rename = { kind: "rename" } as const;
  const restart = { kind: "restart" } as const;
  // Nothing replaced it: the dialog closes.
  expect(closeOwn<object>(rename, rename)).toBeNull();
  // The tray replaced the rename dialog; the rename finishing later must not close the restart.
  expect(closeOwn<object>(restart, rename)).toBe(restart);
  // A new dialog of the same kind is another object and stays open too.
  expect(closeOwn<object>({ kind: "restart" }, restart)).toEqual({ kind: "restart" });
  expect(closeOwn<object>(null, rename)).toBeNull();
});

test("the first-close hint says where Kairomes keeps running and how to end it", () => {
  const markup = renderToStaticMarkup(<CloseHintDialog onClose={noop} onHide={noop} />);
  expect(markup).toContain("系統匣");
  expect(markup).toContain("「結束 Kairomes」");
  const cancel = markup.indexOf(">取消<");
  const hide = markup.indexOf("隱藏視窗");
  expect(cancel).toBeGreaterThan(-1);
  expect(hide).toBeGreaterThan(cancel);
  expect(markup.match(/k-btn--primary/g)).toHaveLength(1);
});
