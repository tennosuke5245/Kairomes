import { ArrowUDownLeftIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { type OutputFilter, outputView } from "./command-model.ts";
import { CopyButton } from "./detail-parts.tsx";
import { iconProps } from "./ui-icons.tsx";

/** Rows in the live tail of running work (C8); finished output shows a longer tail. */
export const LIVE_TAIL = 12;
export const DONE_TAIL = 40;

/**
 * Output tail with line numbers (`.k-output`): 全部／只看 stderr when stderr has content, a
 * 換行 toggle, 完整輸出 for the retained lines, and copy of the filtered text. Untrusted
 * output renders as React text only.
 */
export function OutputView({
  stdout,
  stderr,
  tail = 40,
  status,
  empty = "沒有輸出。",
  title = "輸出",
  evidence,
  numbered = true,
}: {
  stdout: string;
  stderr: string;
  /** Rows shown before 完整輸出; running work shows a short live tail. */
  tail?: number;
  /** A short state such as 尚未讀完, appended to the line count. */
  status?: string;
  empty?: string;
  title?: string;
  /** complete only for a drained, untruncated exit 0 (see commandEvidence). */
  evidence?: "complete" | "unconfirmed";
  /** Off once older output was dropped: numbers counted from the cut would be false. */
  numbered?: boolean;
}) {
  const [filter, setFilter] = useState<OutputFilter>("all");
  const [wrap, setWrap] = useState(true);
  const [full, setFull] = useState(false);
  const view = outputView({ stdout, stderr }, { filter, tail: full ? undefined : tail });
  const count =
    view.hidden > 0
      ? `最後 ${view.rows.filter((row) => row.kind !== "label").length} 行`
      : `${view.total} 行`;
  return (
    <section
      className="k-output wb-output"
      data-wrap={wrap ? undefined : "off"}
      data-evidence={evidence}
      data-numbers={numbered ? undefined : "off"}
      aria-label={title}
    >
      <div className="k-output__head">
        <span className="k-output__title">{title}</span>
        <span className="k-meta wb-output__meta">
          {view.total ? count : ""}
          {view.total && status ? " · " : ""}
          {status}
        </span>
        {(view.hasStderr || view.total > 0) && (
          <div className="wb-output__tools">
            {view.hasStderr && (
              <fieldset className="k-seg wb-seg">
                <legend className="k-sr-only">輸出來源</legend>
                <button
                  type="button"
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  全部
                </button>
                <button
                  type="button"
                  aria-pressed={filter === "stderr"}
                  onClick={() => setFilter("stderr")}
                >
                  只看 stderr
                </button>
              </fieldset>
            )}
            {view.total > 0 && (
              <>
                <button
                  type="button"
                  className="k-btn k-btn--quiet k-btn--sm"
                  aria-pressed={wrap}
                  title="換行"
                  onClick={() => setWrap((value) => !value)}
                >
                  <ArrowUDownLeftIcon {...iconProps("sm")} />
                  <span className="wb-collapse">換行</span>
                </button>
                {(view.hidden > 0 || full) && (
                  <button
                    type="button"
                    className="k-btn k-btn--quiet k-btn--sm"
                    aria-expanded={full}
                    onClick={() => setFull((value) => !value)}
                  >
                    {full ? "只看最後幾行" : "完整輸出"}
                  </button>
                )}
                <CopyButton text={() => view.text} label="複製輸出" iconOnly />
              </>
            )}
          </div>
        )}
      </div>
      {view.rows.length ? (
        <div className="k-output__body">
          {view.rows.map((row) =>
            row.kind === "label" ? (
              <div key={row.key} className="k-output__line wb-output__label">
                <span className="k-output__ln" />
                <span className="k-output__tx">{row.text}</span>
              </div>
            ) : (
              <div key={row.key} className="k-output__line" data-kind={row.kind}>
                <span className="k-output__ln">{numbered ? row.number : null}</span>
                <span className="k-output__tx">{row.text || " "}</span>
              </div>
            ),
          )}
        </div>
      ) : (
        <p className="wb-output__empty">{empty}</p>
      )}
    </section>
  );
}
