import { ArtifactSchema, McpCallSchema, VERSION } from "@kairomes/protocol";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { copyText } from "./copy.ts";
import { hostTheme } from "./host-model.ts";
import {
  artifactView,
  callView,
  emptyView,
  type HostImage,
  mountView,
  TEXT_ID,
  type ViewDocument,
} from "./mcp-result-view.ts";

// The ChatGPT MCP result card (design spec §5.4). It renders the tool result it is given and
// never calls a tool back; text is set with textContent only (mcp-result-view.ts).
type ToolResult = Parameters<NonNullable<App["ontoolresult"]>>[0];

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Missing MCP result root");
const resultRoot = root;
resultRoot.className = "k-app mr";

function hostImages(result: ToolResult): HostImage[] {
  return result.content.flatMap((item) =>
    item.type === "image" ? [{ mimeType: item.mimeType, data: item.data }] : [],
  );
}

/** The 展開全部 control only appears when the clamped text actually overflows. */
function fitText() {
  const block = document.getElementById(TEXT_ID);
  const toggle = document.getElementById(`${TEXT_ID}-toggle`);
  if (!block || !toggle || block.dataset.expanded === "true") return;
  const fits = block.scrollHeight <= block.clientHeight + 1;
  block.dataset.fits = String(fits);
  toggle.hidden = fits;
}

function render(result: ToolResult) {
  const artifact = ArtifactSchema.safeParse(result.structuredContent);
  const call = artifact.success ? undefined : McpCallSchema.safeParse(result.structuredContent);
  const view = artifact.success
    ? artifactView(artifact.data, hostImages(result))
    : call?.success
      ? callView(call.data, hostImages(result))
      : emptyView();
  const card = mountView(document as unknown as ViewDocument, view, (text) => copyText(text));
  resultRoot.replaceChildren(card as unknown as Node);
  requestAnimationFrame(fitText);
}

addEventListener("resize", () => requestAnimationFrame(fitText));

const app = new App({ name: "Kairomes MCP Result", version: VERSION }, {});
const setTheme = (value: unknown) => {
  const theme = hostTheme(value);
  if (theme) applyDocumentTheme(theme);
};
app.ontoolresult = render;
app.onhostcontextchanged = (context) => setTheme(context.theme);
await app.connect(undefined, { timeout: 10000 });
setTheme(app.getHostContext()?.theme);
