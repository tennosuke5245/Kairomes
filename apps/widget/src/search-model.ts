import type { SearchResult } from "@kairomes/protocol";
import { splitPath } from "./file-model.ts";

// Search results (C3): grouped by file, the snippet re-centred so the match is always
// visible, and matches returned as segments for <mark> (React text nodes, never HTML).

/** Default and maximum file_search page. */
export const SEARCH_LIMIT = 50;
/** Hits shown per file before 顯示其餘 N 筆. */
export const HITS_PER_FILE = 3;
/** Characters kept around the first match. */
export const SNIPPET_WINDOW = 120;

export interface SnippetSegment {
  text: string;
  mark: boolean;
}

const ELLIPSIS = "…";

function matchRanges(text: string, query: string, caseSensitive: boolean) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern: RegExp;
  try {
    pattern = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  } catch {
    return [];
  }
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) break;
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  return ranges;
}

/** Moves a cut point off the second half of a surrogate pair. */
function safeCut(text: string, index: number) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

/**
 * Splits a result line into plain and marked segments. Long lines keep a window centred on
 * the first match; `…` appears only at a cut end, never over the match. The daemon may
 * already have clipped the line with `…`, which is kept as text.
 */
export function highlightSnippet(
  text: string,
  query: string,
  options: { caseSensitive?: boolean; window?: number } = {},
): SnippetSegment[] {
  const width = options.window ?? SNIPPET_WINDOW;
  const ranges = matchRanges(text, query, options.caseSensitive ?? false);
  let start = 0;
  let end = text.length;
  if (text.length > width) {
    const first = ranges[0];
    const center = first ? Math.floor((first[0] + first[1]) / 2) : 0;
    start = Math.max(0, Math.min(center - Math.floor(width / 2), text.length - width));
    if (first) start = Math.min(start, first[0]);
    start = safeCut(text, start);
    end = safeCut(text, Math.min(text.length, Math.max(start + width, first ? first[1] : 0)));
  }
  const segments: SnippetSegment[] = [];
  const push = (value: string, mark: boolean) => {
    if (!value) return;
    const last = segments.at(-1);
    if (last && last.mark === mark) last.text += value;
    else segments.push({ text: value, mark });
  };
  if (start > 0) push(ELLIPSIS, false);
  let cursor = start;
  for (const [from, to] of ranges) {
    if (to <= start || from >= end) continue;
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    push(text.slice(cursor, a), false);
    push(text.slice(a, b), true);
    cursor = b;
  }
  push(text.slice(cursor, end), false);
  if (end < text.length) push(ELLIPSIS, false);
  return segments;
}

export interface SearchHit {
  line: number;
  text: string;
}

export interface SearchGroup {
  path: string;
  name: string;
  directory: string;
  hits: SearchHit[];
}

/** Groups matches by file in first-appearance order; hits keep the daemon's line order. */
export function groupMatches(matches: SearchResult["matches"]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const match of matches) {
    let group = groups.get(match.path);
    if (!group) {
      group = { path: match.path, ...splitPath(match.path), hits: [] };
      groups.set(match.path, group);
    }
    group.hits.push({ line: match.line, text: match.text });
  }
  return [...groups.values()];
}

/** One status line: 23 筆 · 已掃描 6 個檔案 (· 已達上限). Hidden files are never mentioned. */
export function searchSummary(
  result: Pick<SearchResult, "matches" | "scanned_files" | "truncated">,
) {
  return [
    `${result.matches.length} 筆`,
    `已掃描 ${result.scanned_files.toLocaleString("en-US")} 個檔案`,
    result.truncated ? "已達上限" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
