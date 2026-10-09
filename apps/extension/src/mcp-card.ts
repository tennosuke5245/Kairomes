import type { McpCatalogTool, McpPanelState } from "@kairomes/protocol";
import { el, metaItem } from "./approval-dom.ts";
import { icon, type PanelIcon, setIcon } from "./icons.ts";
import {
  MCP_RISKS,
  type McpNoticeAction,
  type McpServerView,
  mcpRiskCounts,
  mcpToolRisks,
} from "./mcp-view.ts";

// Keyed DOM for one MCP server card. Cards and tool rows are created once per id and then
// patched in place, so the 10 s catalog refresh never steals focus, collapses an open tool
// list or rebuilds a switch under the pointer. Untrusted strings only reach textContent.

type Server = McpPanelState["servers"][number];

export interface McpCardHandlers {
  toggleServer(id: string): void;
  toggleTool(id: string, tool: string): void;
  notice(id: string, action: McpNoticeAction): void;
  refresh(id: string): void;
  forget(id: string): void;
  remove(id: string): void;
  expand(id: string): void;
}

export interface McpCardState {
  server: Server;
  view: McpServerView;
  /** Tools to list: every tool, or the search matches when `narrowed`. */
  tools: readonly McpCatalogTool[];
  /** Search matched individual tools: the list shows them without the disclosure. */
  narrowed: boolean;
  expanded: boolean;
  disabled: {
    server: boolean;
    tools: boolean;
    notice: boolean;
    refresh: boolean;
    forget: boolean;
    remove: boolean;
  };
}

export function setText(element: Element, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

function setAttr(element: Element, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name);
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setHidden(element: HTMLElement, hidden: boolean) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

/** Moves only the nodes that are out of place; a focused node that stays in order is kept. */
export function syncChildren(parent: Element, nodes: readonly Element[]) {
  const keep = new Set(nodes);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  nodes.forEach((node, index) => {
    const current = parent.children[index];
    if (current !== node) parent.insertBefore(node, current ?? null);
  });
}

function quietButton(className: string, focus: string) {
  const button = el("button", className);
  button.type = "button";
  button.dataset.mcpFocus = focus;
  return button;
}

/** The catalog, not the click, decides a switch's state: the click only asks for a change. */
function switchInput(focus: string, onToggle: () => void) {
  const input = el("input", "k-switch");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.dataset.mcpFocus = focus;
  input.addEventListener("click", (event) => {
    event.preventDefault();
    if (event.isTrusted && !input.disabled) onToggle();
  });
  return input;
}

class ToolRow {
  readonly element = el("li", "mcp-tool");
  private readonly name = el("span", "mcp-tool__name");
  private readonly risks = el("span", "mcp-tool__risks");
  private readonly toggle: HTMLInputElement;
  private signature = "";

  constructor(
    serverId: string,
    readonly toolName: string,
    handlers: McpCardHandlers,
  ) {
    this.toggle = switchInput(`tool:${serverId}:${toolName}`, () =>
      handlers.toggleTool(serverId, toolName),
    );
    const text = el("span", "mcp-tool__text");
    text.append(this.name, this.risks);
    this.element.append(text, this.toggle);
  }

  update(tool: McpCatalogTool, disabled: boolean) {
    setText(this.name, tool.name);
    const unavailable =
      tool.availability === "unavailable" || tool.availability === "schema_changed";
    const kinds = mcpToolRisks(tool);
    const signature = `${kinds.join(",")}|${unavailable ? tool.availability : ""}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.risks.replaceChildren(
        ...kinds.map((kind) => {
          const risk = MCP_RISKS[kind];
          const label = el("span", "mcp-tool__risk");
          label.dataset.tone = risk.tone;
          label.append(icon(risk.icon, { size: "sm" }), document.createTextNode(risk.label));
          return label;
        }),
      );
      if (unavailable) {
        const label = el("span", "mcp-tool__risk");
        label.dataset.tone = "danger";
        label.append(
          icon("WarningCircle", { size: "sm" }),
          document.createTextNode(
            tool.availability === "schema_changed" ? "定義已變更" : "無法使用",
          ),
        );
        this.risks.append(label);
      }
    }
    if (this.toggle.checked !== tool.enabled) this.toggle.checked = tool.enabled;
    setAttr(this.toggle, "aria-label", tool.title ? `${tool.name}（${tool.title}）` : tool.name);
    if (this.toggle.disabled !== disabled) this.toggle.disabled = disabled;
  }
}

export class McpServerCard {
  readonly element = el("article", "k-card mcp-card");
  private readonly name = el("h3", "mcp-card__name");
  private readonly meta = el("p", "mcp-card__meta sp-meta");
  private readonly statusMark = el("span", "mcp-card__mark");
  private readonly statusLabel = el("span", "mcp-card__state");
  private readonly metaRest = el("span", "mcp-card__facts");
  private readonly toggle: HTMLInputElement;
  private readonly notice = el("div", "k-notice mcp-card__notice");
  private readonly noticeIcon = icon("Info");
  private readonly noticeText = el("p", "mcp-card__notice-text");
  private readonly noticeDetail = el("p", "mcp-card__notice-detail");
  private readonly noticeAction: HTMLButtonElement;
  private noticeKind?: McpNoticeAction;
  private readonly risks = el("ul", "mcp-card__risks");
  private riskSignature = "";
  private readonly tools = el("ul", "mcp-tools");
  private readonly rows = new Map<string, ToolRow>();
  private readonly expand: HTMLButtonElement;
  private readonly expandLabel = el("span");
  private readonly refresh: HTMLButtonElement;
  private readonly forget: HTMLButtonElement;
  private readonly remove: HTMLButtonElement;
  private statusSignature = "";

  constructor(
    readonly id: string,
    private readonly handlers: McpCardHandlers,
  ) {
    const card = this.element;
    card.dataset.serverId = id;
    card.dataset.mcpFocus = `card:${id}`;
    card.tabIndex = -1;
    this.name.id = `mcp-name-${id}`;
    card.setAttribute("aria-labelledby", this.name.id);

    const head = el("div", "mcp-card__head");
    const kind = el("span", "k-kind");
    kind.append(icon("HardDrives", { size: "lg" }));
    const identity = el("div", "mcp-card__id");
    this.meta.append(this.statusMark, this.statusLabel, this.metaRest);
    identity.append(this.name, this.meta);
    this.toggle = switchInput(`server:${id}`, () => handlers.toggleServer(id));
    head.append(kind, identity, this.toggle);

    const body = el("div", "k-notice__body");
    body.append(this.noticeText, this.noticeDetail);
    this.noticeAction = quietButton("k-btn k-btn--sm k-notice__action", `notice:${id}`);
    this.noticeAction.addEventListener("click", (event) => {
      if (event.isTrusted && this.noticeKind) handlers.notice(id, this.noticeKind);
    });
    this.notice.append(this.noticeIcon, body, this.noticeAction);
    this.notice.hidden = true;

    this.risks.setAttribute("aria-label", "工具標示（由伺服器提供）");
    this.tools.id = `mcp-tools-${id}`;
    this.tools.setAttribute("aria-label", "工具");
    this.tools.hidden = true;

    const foot = el("div", "mcp-card__foot");
    this.expand = quietButton("k-btn k-btn--quiet k-btn--sm mcp-card__expand", `tools:${id}`);
    this.expand.setAttribute("aria-controls", this.tools.id);
    this.expand.setAttribute("aria-expanded", "false");
    this.expand.append(this.expandLabel, icon("CaretDown", { size: "sm" }));
    this.expand.addEventListener("click", () => handlers.expand(id));
    this.refresh = quietButton("k-btn k-btn--quiet k-btn--icon k-btn--sm", `refresh:${id}`);
    this.refresh.append(icon("ArrowClockwise"));
    this.refresh.addEventListener("click", (event) => {
      if (event.isTrusted) handlers.refresh(id);
    });
    this.forget = quietButton("k-btn k-btn--quiet k-btn--sm mcp-card__forget", `forget:${id}`);
    this.forget.append(icon("SignOut", { size: "sm" }), el("span", undefined, "清除登入"));
    this.forget.addEventListener("click", (event) => {
      if (event.isTrusted) handlers.forget(id);
    });
    this.remove = quietButton(
      "k-btn k-btn--danger-quiet k-btn--sm mcp-card__remove",
      `remove:${id}`,
    );
    this.remove.append(icon("Trash", { size: "sm" }), el("span", undefined, "移除"));
    this.remove.addEventListener("click", (event) => {
      if (event.isTrusted) handlers.remove(id);
    });
    // Sign-out and remove stay together at the end, wrapping as one group when space runs out.
    const end = el("span", "mcp-card__end");
    end.append(this.forget, this.remove);
    foot.append(this.expand, this.refresh, end);

    card.append(head, this.notice, this.risks, this.tools, foot);
  }

  update(state: McpCardState) {
    const { server, view, disabled } = state;
    setText(this.name, server.name);
    setAttr(this.element, "data-mode", view.mode);

    // Status: a dot for steady states, an icon otherwise; the label always carries the text.
    const status = view.status;
    const statusSignature = `${status.tone}|${status.icon}|${status.spin}`;
    if (statusSignature !== this.statusSignature) {
      this.statusSignature = statusSignature;
      const mark =
        status.icon === "Dot"
          ? el("span", "k-dot")
          : icon(status.icon as PanelIcon, { size: "sm", spin: status.spin });
      mark.setAttribute("data-tone", status.tone);
      this.statusMark.replaceChildren(mark);
      setAttr(this.meta, "data-tone", status.tone);
    }
    setText(this.statusLabel, status.label);
    const facts = view.meta.join("\u0000");
    if (this.metaRest.dataset.facts !== facts) {
      this.metaRest.dataset.facts = facts;
      // Each separator travels with its fact, so a wrapped line never shows a dangling ·.
      this.metaRest.replaceChildren(...view.meta.map((fact) => metaItem(fact)));
    }

    setHidden(this.toggle, !view.switchVisible);
    if (this.toggle.checked !== server.enabled) this.toggle.checked = server.enabled;
    setAttr(this.toggle, "aria-label", server.name);
    if (this.toggle.disabled !== disabled.server) this.toggle.disabled = disabled.server;

    const notice = view.notice;
    setHidden(this.notice, !notice);
    if (notice) {
      setAttr(this.notice, "data-tone", notice.tone);
      setIcon(this.noticeIcon, notice.icon);
      setText(this.noticeText, notice.text);
      setText(this.noticeDetail, notice.detail ?? "");
      setHidden(this.noticeDetail, !notice.detail);
      this.noticeKind = notice.action?.kind;
      setHidden(this.noticeAction, !notice.action);
      if (notice.action) {
        setText(this.noticeAction, notice.action.label);
        setAttr(
          this.noticeAction,
          "class",
          `k-btn k-btn--sm k-notice__action ${notice.action.primary ? "k-btn--primary" : "k-btn--secondary"}`,
        );
        if (this.noticeAction.disabled !== disabled.notice)
          this.noticeAction.disabled = disabled.notice;
      }
    } else this.noticeKind = undefined;

    const counts = mcpRiskCounts(server.tools);
    const riskSignature = counts.map(({ kind, count }) => `${kind}:${count}`).join(",");
    if (riskSignature !== this.riskSignature) {
      this.riskSignature = riskSignature;
      this.risks.replaceChildren(
        ...counts.map(({ tone, icon: name, label, count }) => {
          const item = el("li", "k-pill");
          item.dataset.tone = tone;
          item.append(icon(name), document.createTextNode(`${label} ${count}`));
          return item;
        }),
      );
    }
    setHidden(this.risks, !counts.length);

    const listVisible = state.tools.length > 0 && (state.narrowed || state.expanded);
    setHidden(this.tools, !listVisible);
    if (listVisible) {
      const rows = state.tools.map((tool) => {
        let row = this.rows.get(tool.name);
        if (!row) {
          row = new ToolRow(this.id, tool.name, this.handlers);
          this.rows.set(tool.name, row);
        }
        row.update(tool, disabled.tools);
        return row.element;
      });
      syncChildren(this.tools, rows);
      const names = new Set(server.tools.map((tool) => tool.name));
      for (const name of this.rows.keys()) if (!names.has(name)) this.rows.delete(name);
    }

    setHidden(this.expand, state.narrowed || !server.tools.length);
    setText(this.expandLabel, `全部 ${server.tools.length} 個工具`);
    setAttr(this.expand, "aria-expanded", String(listVisible && !state.narrowed));
    setHidden(this.refresh, !view.refreshVisible);
    setAttr(this.refresh, "aria-label", `重新探索 ${server.name}`);
    setAttr(this.refresh, "title", "重新探索");
    this.refresh.disabled = disabled.refresh;
    setHidden(this.forget, !view.forgetVisible);
    this.forget.disabled = disabled.forget;
    this.remove.disabled = disabled.remove;
    setAttr(this.remove, "aria-label", `移除 ${server.name}`);
  }
}
