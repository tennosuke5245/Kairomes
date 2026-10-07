import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { hostTabs } from "./host-model.ts";
import { HostBack, HostEmptyDetail, ViewTabs, viewTabId } from "./host-shell.tsx";

const noop = () => {};

test("host tabs are WAI-ARIA tabs; a muted tab stays visible with its reason", () => {
  const tabs = hostTabs({
    projects: 1,
    selected: true,
    status: { write: true, command: true, terminal: false },
  });
  const html = renderToStaticMarkup(
    <ViewTabs tabs={tabs} current="commands" panelId="hv" className="hv-tabs" onSelect={noop} />,
  );
  expect(html).toContain('role="tablist"');
  expect(html.match(/role="tab"/g)).toHaveLength(4);
  expect(html).toContain(`id="${viewTabId("hv", "commands")}"`);
  expect(html).toContain('aria-controls="hv"');
  // One tab stop: the selected tab.
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*>命令</);
  // 終端機 is muted, not removed, and says why to pointer and screen-reader users.
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain('title="這台電腦目前無法開啟終端機"');
  expect(html).toContain('<span class="k-sr-only">（這台電腦目前無法開啟終端機）</span>');
  expect(html.match(/aria-disabled/g)).toHaveLength(1);
  // A visible cue besides colour: the muted tab carries a lock icon, the others none.
  expect(html.match(/<svg/g)).toHaveLength(1);
  expect(html).toMatch(/aria-disabled="true"[^>]*><svg[^>]*class="k-icon"[^>]*data-size="sm"/);
  // No English eyebrows or counters from the old host layout.
  expect(html).not.toMatch(/ACTIVE WORKSPACE|PROJECT FILES|UTF-8|READ ONLY|HOST PTY/);
});

test("the wide empty pane and the narrow back step use one line each", () => {
  expect(renderToStaticMarkup(<HostEmptyDetail hasProject />)).toContain("從左側選擇檔案");
  const none = renderToStaticMarkup(<HostEmptyDetail hasProject={false} />);
  expect(none).toContain("還沒有專案");
  expect(none).toContain("請先在 Kairomes Desktop 加入專案。");
  const back = renderToStaticMarkup(<HostBack label="返回檔案清單" onBack={noop} />);
  expect(back).toContain("hv-back");
  expect(back).toContain("返回檔案清單");
});
