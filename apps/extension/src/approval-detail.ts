import { type DiffFile, diffPathParts, parseUnifiedDiff } from "@kairomes/protocol/diff-lines";
import {
  appendVisible,
  argvList,
  codebox,
  diffStatElement,
  el,
  fact,
  metaItem,
  pill,
  textButton,
  workspaceTag,
} from "./approval-dom.ts";
import type { ApprovalItem } from "./approval-state.ts";
import {
  clockTime,
  cwdNote,
  diffCoversFiles,
  diffStatusPill,
  fileOperationLabel,
  requestMetaLabel,
  riskStrip,
  timeLimit,
  workspaceHue,
} from "./approval-view.ts";
import { icon } from "./icons.ts";

// The reviewed content of one request, built once per open from the immutable copy under
// review. Everything is text nodes: argv, paths, diffs and the model's explanation never
// become markup, and invisible characters are shown as marked escapes.

type ChangeItem = Extract<ApprovalItem, { files: unknown }>;

/** Shared, per-page diff preference (wrap is on by default). */
export interface DiffView {
  wrap: boolean;
}

export function riskElement(item: ApprovalItem, windows: boolean) {
  const view = riskStrip(item, windows);
  const strip = el("div", "k-risk");
  strip.setAttribute("role", "note");
  if (view.tone === "neutral") strip.dataset.tone = "neutral";
  const title = el("p", "k-risk__title");
  title.append(icon(view.icon, { fill: view.fill }), el("span", undefined, view.title));
  strip.append(title, el("p", "k-risk__text", view.text));
  if (view.facts.length) {
    const facts = el("ul", "k-risk__facts");
    for (const entry of view.facts) {
      const item = el("li", "k-risk__fact");
      item.append(icon(entry.icon), el("span", undefined, entry.label));
      facts.append(item);
    }
    strip.append(facts);
  }
  return strip;
}

export function quote(text: string) {
  const figure = el("figure", "k-quote");
  const body = el("blockquote", "k-quote__text");
  appendVisible(body, text);
  figure.append(el("figcaption", "k-quote__label", "ChatGPT 的說明（未經驗證）"), body);
  return figure;
}

export function facts(item: ApprovalItem, view: DiffView): HTMLElement[] {
  if ("files" in item) return changeFacts(item, view);
  // An image import has its own body (import-view.ts): target, verified preview and source.
  if ("source_file_id" in item) return [];
  const list = el("dl", "k-dl");
  const argv = "argv" in item ? item.argv : item.command;
  const directory = fact("工作目錄", codebox(item.absolute_cwd));
  const note = cwdNote(item);
  if (note) directory.append(el("p", "k-dl__note", note));
  list.append(
    "argv" in item ? fact("執行檔", codebox(item.executable)) : fact("Shell", codebox(item.shell)),
    fact(`參數（${argv.length} 個）`, argvList(argv)),
    directory,
  );
  const limit = timeLimit(item);
  if (limit) list.append(fact("時限", limit));
  return [list];
}

function changeFacts(item: ChangeItem, view: DiffView): HTMLElement[] {
  if (!item.diff_available) return [fileList(item)];
  const parsed = parseUnifiedDiff(item.diff, { truncated: item.diff_truncated });
  const bar = el("div", "rq-diffbar");
  const toggle = textButton("自動換行", "k-btn k-btn--quiet k-btn--sm", "ArrowUDownLeft");
  toggle.setAttribute("aria-pressed", String(view.wrap));
  bar.append(
    el("span", "rq-diffbar__title", `${item.files.length} 個檔案`),
    diffStatElement(parsed.additions, parsed.deletions),
    toggle,
  );
  // The sections must cover exactly the reviewed files; otherwise show the raw text.
  const sections = diffCoversFiles(
    parsed.files.map((file) => file.path),
    item.files,
  )
    ? parsed.files.map((file) => diffSection(file))
    : [rawDiff(item.diff, item.diff_truncated)];
  const applyWrap = () => {
    toggle.setAttribute("aria-pressed", String(view.wrap));
    for (const section of sections)
      if (view.wrap) delete section.dataset.wrap;
      else section.dataset.wrap = "off";
  };
  toggle.addEventListener("click", () => {
    view.wrap = !view.wrap;
    applyWrap();
  });
  applyWrap();
  const group = el("div", "rq-diffs");
  group.append(...sections);
  return [bar, group];
}

function diffSection(file: DiffFile) {
  const section = el("section", "k-diff");
  section.setAttribute("aria-label", file.path);
  const head = el("div", "k-diff__head");
  const path = el("span", "k-diff__path");
  const parts = diffPathParts(file.path);
  path.append(
    appendVisible(el("span", "k-diff__dir"), parts.directory),
    appendVisible(el("span", "k-diff__file"), parts.name),
  );
  if (file.previousPath) {
    const from = el("span", "rq-diff__from", "原為 ");
    appendVisible(from, file.previousPath);
    path.append(from);
  }
  const status = diffStatusPill(file.status);
  const collapse = el("button", "k-btn k-btn--quiet k-btn--icon k-btn--sm rq-diff__toggle");
  collapse.type = "button";
  collapse.setAttribute("aria-expanded", "true");
  collapse.setAttribute("aria-label", `收合 ${file.path}`);
  collapse.append(icon("CaretDown"));
  head.append(
    path,
    pill(status.tone, undefined, status.label),
    diffStatElement(file.additions, file.deletions),
    collapse,
  );
  const body = el("div", "k-diff__body");
  for (const line of file.lines) body.append(diffLine(line));
  if (file.binary) body.append(el("p", "rq-diff__note", "二進位檔案，無法顯示內容。"));
  if (file.truncated) body.append(el("p", "rq-diff__note", "差異到這裡截斷。"));
  if (!file.lines.length && !file.binary && !file.truncated)
    body.append(el("p", "rq-diff__note", "沒有內容變更。"));
  collapse.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    collapse.setAttribute("aria-expanded", String(open));
    collapse.setAttribute("aria-label", `${open ? "收合" : "展開"} ${file.path}`);
    // Collapsed files keep their path, kind and +N −M visible.
    if (open) delete section.dataset.collapsed;
    else section.dataset.collapsed = "";
  });
  section.append(head, body);
  return section;
}

function diffLine(line: DiffFile["lines"][number]) {
  const row = el("div", "k-diff__line");
  if (line.kind !== "context") row.dataset.kind = line.kind;
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
  const code = el("span", "k-diff__code");
  if (line.kind === "hunk") code.textContent = line.label ?? line.text;
  else appendVisible(code, line.text, { keepTabs: true });
  row.append(
    el(
      "span",
      "k-diff__ln k-diff__ln--old",
      line.oldLine === undefined ? "" : String(line.oldLine),
    ),
    el("span", "k-diff__ln", line.newLine === undefined ? "" : String(line.newLine)),
    el("span", "k-diff__sign", sign),
    code,
  );
  return row;
}

/** Fallback when the parsed sections do not match the reviewed files: the raw text. */
function rawDiff(text: string, truncated: boolean) {
  const section = el("section", "k-diff");
  section.setAttribute("aria-label", "檔案差異");
  const body = el("div", "k-diff__body");
  body.append(
    appendVisible(el("pre", "rq-diff__raw"), text, { keepTabs: true, keepNewlines: true }),
  );
  if (truncated) body.append(el("p", "rq-diff__note", "差異到這裡截斷。"));
  section.append(body);
  return section;
}

function fileList(item: ChangeItem) {
  const list = el("ul", "k-card rq-files");
  list.setAttribute("aria-label", "檔案");
  for (const file of item.files) {
    const entry = el("li", "rq-files__item");
    entry.append(
      appendVisible(el("span", "rq-files__path"), file.path),
      pill("neutral", undefined, fileOperationLabel(file.operation)),
    );
    list.append(entry);
  }
  return list;
}

export function requestMeta(item: ApprovalItem, now: number) {
  const meta = el("p", "rq-meta sp-meta");
  const id = requestMetaLabel(item);
  const request = el("span", undefined, `${id.label} `);
  request.append(el("span", "k-mono", id.value));
  const time = metaItem(`${clockTime(item.created_at, now)} 提出`);
  // An import names its project under 專案 already; the tag would only repeat it, and the line
  // then starts with its ID (no leading separator).
  if ("source_file_id" in item) {
    const first = el("span", "sp-meta__item");
    first.append(request);
    meta.append(first, time);
  } else
    meta.append(
      workspaceTag(item.workspace_name, workspaceHue(item.workspace_id)),
      metaItem(request),
      time,
    );
  return meta;
}
