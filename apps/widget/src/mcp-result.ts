import {
  type Artifact,
  ArtifactSchema,
  type McpCall,
  McpCallSchema,
  VERSION,
} from "@kairomes/protocol";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";

type ToolResult = Parameters<NonNullable<App["ontoolresult"]>>[0];
type ToolResultImage = Extract<ToolResult["content"][number], { type: "image" }>;

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Missing MCP result root");
const resultRoot = root;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  return value;
}

function parseCall(value: unknown): McpCall | undefined {
  const parsed = McpCallSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseArtifact(value: unknown): Artifact | undefined {
  const parsed = ArtifactSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function resultImages(result: ToolResult) {
  return result.content.filter(
    (item): item is ToolResultImage =>
      item.type === "image" && ["image/png", "image/jpeg", "image/webp"].includes(item.mimeType),
  );
}

function cardHeader(eyebrowText: string, titleText: string, statusText: string, error = false) {
  const header = element("header", "result-header");
  const brand = element("div", "result-brand");
  const mark = element("span", "result-mark");
  const brandCopy = element("div");
  const eyebrow = element("small");
  eyebrow.textContent = eyebrowText;
  const title = element("h1");
  title.textContent = titleText;
  brandCopy.append(eyebrow, title);
  brand.append(mark, brandCopy);
  const status = element("span", `result-status${error ? " error" : ""}`);
  status.textContent = statusText;
  header.append(brand, status);
  return header;
}

function appendGallery(
  card: HTMLElement,
  images: ToolResultImage[],
  label: string,
  dimensions: Array<{ width: number; height: number; mimeType: string }>,
) {
  if (!images.length) return;
  const gallery = element("section", "result-gallery");
  for (const [index, image] of images.entries()) {
    const figure = element("figure");
    const preview = element("img");
    preview.alt = `${label} ${index + 1}`;
    preview.src = `data:${image.mimeType};base64,${image.data}`;
    const size = dimensions[index];
    const caption = element("figcaption");
    caption.textContent = size
      ? `${size.width.toLocaleString()} × ${size.height.toLocaleString()} · ${size.mimeType}`
      : image.mimeType;
    figure.append(preview, caption);
    gallery.append(figure);
  }
  card.append(gallery);
}

function renderArtifact(result: ToolResult, artifact: Artifact) {
  const card = element("article", "result-card");
  const fileName = artifact.path.split(/[\\/]/).pop() ?? artifact.path;
  card.append(cardHeader("KAIROMES · MEDIA PREVIEW", fileName, "安全預覽"));

  const meta = element("div", "result-meta");
  const path = element("strong");
  path.textContent = artifact.path;
  const kind = element("span");
  kind.textContent = "工作區圖片";
  meta.append(path, kind);
  card.append(meta);

  const images = resultImages(result);
  appendGallery(card, images, `${fileName} 的圖片預覽`, [
    { width: artifact.width, height: artifact.height, mimeType: artifact.mime_type },
  ]);
  if (!images.length) {
    const notice = element("p", "result-notice");
    notice.textContent = "圖片資料未送達這個 ChatGPT 元件；Kairomes 工作台仍保留安全預覽。";
    card.append(notice);
  }
  resultRoot.append(card);
}

function render(result: ToolResult) {
  const artifact = parseArtifact(result.structuredContent);
  if (artifact) {
    resultRoot.replaceChildren();
    renderArtifact(result, artifact);
    return;
  }
  const call = parseCall(result.structuredContent);
  resultRoot.replaceChildren();
  if (!call) {
    const unavailable = element("section", "result-empty");
    unavailable.textContent = "Kairomes 沒有收到可顯示的 MCP 結果。";
    resultRoot.append(unavailable);
    return;
  }

  const card = element("article", "result-card");
  const label = call.tool.title ?? call.tool.name;
  const header = cardHeader(
    "KAIROMES · MCP RESULT",
    label,
    call.is_error ? "工具回報錯誤" : "呼叫完成",
    call.is_error,
  );

  const meta = element("div", "result-meta");
  const server = element("strong");
  server.textContent = call.tool.server_name;
  const duration = element("span");
  duration.textContent = `${call.duration_ms.toLocaleString()} ms`;
  meta.append(server, duration);
  card.append(header, meta);

  const images = resultImages(result);
  appendGallery(
    card,
    images,
    `${label} 的 MCP 圖片結果`,
    call.content
      .filter((item) => item.type === "image")
      .map((item) => ({ width: item.width, height: item.height, mimeType: item.mime_type })),
  );

  const textResults = call.content.filter(
    (item): item is Extract<McpCall["content"][number], { type: "text" }> => item.type === "text",
  );
  if (textResults.length) {
    const output = element("section", "result-output");
    if (call.is_error) output.classList.add("error");
    const heading = element("h2");
    heading.textContent = "工具回傳";
    const body = element("pre");
    body.textContent = textResults.map((item) => item.text).join("\n\n");
    output.append(heading, body);
    card.append(output);
  }

  if (call.structured_content) {
    const structured = element("details", "result-details");
    const structuredSummary = element("summary");
    structuredSummary.textContent = "查看結構化結果";
    const structuredBody = element("pre");
    structuredBody.textContent = JSON.stringify(call.structured_content, null, 2);
    structured.append(structuredSummary, structuredBody);
    card.append(structured);
  }

  const details = element("details", "result-details");
  const summary = element("summary");
  summary.textContent = "查看呼叫內容";
  const argumentsPreview = element("pre");
  argumentsPreview.textContent = JSON.stringify(call.arguments_preview, null, 2);
  details.append(summary, argumentsPreview);
  card.append(details);

  const omittedMedia = call.content.filter((item) => item.type === "media_omitted").length;
  if (call.truncated || omittedMedia) {
    const notice = element("p", "result-notice");
    notice.textContent = omittedMedia
      ? `${omittedMedia} 個不支援或超過限制的媒體結果未顯示；其餘內容已安全保留。`
      : "部分下游內容超過安全顯示上限，已由 Kairomes 省略。";
    card.append(notice);
  }
  resultRoot.append(card);
}

const app = new App({ name: "Kairomes MCP Result", version: VERSION }, {});
app.ontoolresult = render;
app.onhostcontextchanged = (context) => {
  if (context.theme) applyDocumentTheme(context.theme);
};
await app.connect(undefined, { timeout: 10000 });
const theme = app.getHostContext()?.theme;
if (theme) applyDocumentTheme(theme);
