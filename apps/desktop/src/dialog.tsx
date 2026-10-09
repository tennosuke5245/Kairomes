import { ArrowSquareOut, CircleNotch, Eye, EyeSlash } from "@phosphor-icons/react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { openExternal, saveRuntimeApiKey } from "./api.ts";
import { Icon } from "./components.tsx";
import { validateProjectName } from "./model.ts";
import { errorText } from "./notice.ts";

/**
 * The dialog state once `mine` closes: only that dialog closes. A dialog that replaced it in
 * the meantime (the tray's restart confirmation) stays open when the replaced dialog's own
 * action finishes later and calls its onClose.
 */
export function closeOwn<T extends object>(current: T | null, mine: T): T | null {
  return current === mine ? null : current;
}

/** Where focus goes when the element that opened a dialog is gone: the page title. */
function focusFallback() {
  document.querySelector<HTMLElement>(".desk-main h1")?.focus();
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab goes inside a modal: the first control after the last and the last before the
 * first; null lets the browser move focus normally. WebView2 has no browser chrome to tab
 * into, so without this wrap focus would leave the page instead of cycling the dialog.
 */
export function wrapFocusIndex(count: number, active: number, backwards: boolean): number | null {
  if (count <= 0) return null;
  if (active < 0) return backwards ? count - 1 : 0;
  if (backwards) return active === 0 ? count - 1 : null;
  return active === count - 1 ? 0 : null;
}

/**
 * One accessible modal for every Desktop dialog (A11): a native `<dialog>` opened with
 * showModal(), so the background is inert, and Tab wraps inside it. Esc and a backdrop click
 * close it unless it is busy; focus starts on `initialFocus` and returns to the opener.
 */
export function Dialog({
  title,
  busy = false,
  onClose,
  initialFocus,
  children,
  actions,
  onSubmit,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  initialFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
  actions: ReactNode;
  /** Makes the dialog a form, so Enter submits. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  // Esc and the backdrop call the latest onClose, and do nothing while the dialog is busy.
  const closeRequest = useRef(onClose);
  useLayoutEffect(() => {
    closeRequest.current = busy ? () => undefined : onClose;
  });

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    if (!element.open) element.showModal();
    initialFocus.current?.focus();
    // A press that starts and ends on the backdrop (the dialog box itself, outside its content)
    // closes like 取消; Esc arrives as the native cancel event.
    let pressedOutside = false;
    const press = (event: PointerEvent) => {
      pressedOutside = event.target === element;
    };
    const click = (event: MouseEvent) => {
      if (event.target === element && pressedOutside) closeRequest.current();
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      closeRequest.current();
    };
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => item.getClientRects().length > 0,
      );
      const active = document.activeElement;
      const next = wrapFocusIndex(
        items.length,
        items.indexOf(active as HTMLElement),
        event.shiftKey,
      );
      if (!items.length || next !== null) event.preventDefault();
      if (next !== null) items[next]?.focus();
    };
    element.addEventListener("pointerdown", press);
    element.addEventListener("click", click);
    element.addEventListener("cancel", cancel);
    element.addEventListener("keydown", trap);
    return () => {
      element.removeEventListener("pointerdown", press);
      element.removeEventListener("click", click);
      element.removeEventListener("cancel", cancel);
      element.removeEventListener("keydown", trap);
      if (element.open) element.close();
      if (
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected &&
        !opener.closest("dialog")
      )
        opener.focus();
      else focusFallback();
    };
  }, [initialFocus]);

  const content = (
    <>
      <div className="k-dialog__head">
        <h2 className="k-dialog__title" id={titleId}>
          {title}
        </h2>
      </div>
      <div className="k-dialog__body" id={bodyId}>
        {children}
      </div>
      <div className="k-dialog__actions">{actions}</div>
    </>
  );

  return (
    <dialog
      ref={dialog}
      className="k-dialog desk-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      aria-busy={busy}
    >
      {onSubmit ? (
        <form className="desk-dialog__form" onSubmit={onSubmit} noValidate>
          {content}
        </form>
      ) : (
        content
      )}
    </dialog>
  );
}

/**
 * Destructive confirmation: one consequence sentence, 取消 first and focused, the danger
 * button second. The consequence never promises that anything comes back.
 */
export function ConfirmDialog({
  title,
  consequence,
  confirmLabel,
  blocked = false,
  onConfirm,
  onClose,
}: {
  title: string;
  consequence: string;
  confirmLabel: string;
  /** Another action is still running (busyAction): the confirm waits for it. */
  blocked?: boolean;
  /** Resolves when done; a rejection keeps the dialog open with the fixed error text. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const blockedId = useId();
  // After a failure the buttons come back; focus returns to the safe choice.
  useEffect(() => {
    if (error && !busy) cancel.current?.focus();
  }, [error, busy]);
  const confirm = async () => {
    if (busy || blocked) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (caught) {
      setError(errorText(caught, "操作沒有完成，請再試一次。"));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      busy={busy}
      onClose={onClose}
      initialFocus={cancel}
      actions={
        <>
          <button
            ref={cancel}
            className="k-btn k-btn--secondary k-btn--lg"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="k-btn k-btn--danger k-btn--lg"
            type="button"
            aria-busy={busy}
            aria-describedby={blocked && !busy ? blockedId : undefined}
            disabled={busy || blocked}
            onClick={() => void confirm()}
          >
            {busy ? <Icon icon={CircleNotch} spin /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="desk-dialog__text">{consequence}</p>
      {blocked && !busy ? (
        <p className="k-hint" id={blockedId}>
          另一個操作還在進行，完成後才能繼續。
        </p>
      ) : null}
      {error ? (
        <p className="k-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/**
 * The one-time hint on the first close of the window (it replaces the old 關閉後仍執行 pill):
 * Kairomes stays in the tray, and the tray menu is where it ends. 隱藏視窗 finishes the close;
 * 取消 or Esc keeps the window open. Every later close hides the window without asking.
 */
export function CloseHintDialog({ onClose, onHide }: { onClose: () => void; onHide: () => void }) {
  const hide = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title="Kairomes 會在系統匣繼續執行"
      onClose={onClose}
      initialFocus={hide}
      actions={
        <>
          <button className="k-btn k-btn--secondary k-btn--lg" type="button" onClick={onClose}>
            取消
          </button>
          <button
            ref={hide}
            className="k-btn k-btn--primary k-btn--lg"
            type="button"
            onClick={onHide}
          >
            隱藏視窗
          </button>
        </>
      }
    >
      <p className="desk-dialog__text">
        關閉視窗不會停止 Kairomes。要結束，請在系統匣圖示的選單選擇「結束 Kairomes」。
      </p>
    </Dialog>
  );
}

/** Runtime API Key entry. The key goes straight to the OS credential store and is never shown again. */
export function KeyDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hintId = useId();
  const errorId = useId();
  // A refused save re-enables the field; focus goes back to it with the error announced.
  useEffect(() => {
    if (error && !busy) input.current?.focus();
  }, [error, busy]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const key = value.trim();
    if (key.length < 8) {
      setError("請貼上完整的 Runtime API Key。");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveRuntimeApiKey(key);
      setValue("");
      await onSaved();
      onClose();
    } catch (caught) {
      setError(errorText(caught, "無法保存金鑰，請再試一次。"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="設定 Runtime API Key"
      busy={busy}
      onClose={onClose}
      initialFocus={input}
      onSubmit={(event) => void submit(event)}
      actions={
        <>
          <button
            className="k-btn k-btn--secondary k-btn--lg"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="k-btn k-btn--primary k-btn--lg"
            type="submit"
            aria-busy={busy}
            disabled={busy}
          >
            {busy ? <Icon icon={CircleNotch} spin /> : null}
            儲存金鑰
          </button>
        </>
      }
    >
      <div>
        <label className="k-label" htmlFor="runtime-key">
          Runtime API Key
        </label>
        <div className="desk-key-field">
          <input
            ref={input}
            id="runtime-key"
            className="k-input k-input--mono"
            type={visible ? "text" : "password"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="貼上金鑰"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${errorId} ${hintId}` : hintId}
            disabled={busy}
          />
          <button
            className="k-btn k-btn--quiet k-btn--icon"
            type="button"
            aria-pressed={visible}
            aria-label="顯示金鑰"
            onClick={() => setVisible((current) => !current)}
          >
            <Icon icon={visible ? EyeSlash : Eye} />
          </button>
        </div>
        {error ? (
          <p className="k-error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
        <p className="k-hint" id={hintId}>
          交給 Windows 認證管理員保管，之後不會再顯示。
        </p>
      </div>
      <button className="k-link" type="button" onClick={() => void openExternal("runtime_keys")}>
        金鑰從哪裡取得？
        <Icon icon={ArrowSquareOut} size="sm" />
      </button>
    </Dialog>
  );
}

/**
 * Renames a project in Kairomes only; the folder on disk keeps its name. The registry's rule
 * is checked first, and the host's own fixed message is shown when it still refuses.
 */
export function RenameDialog({
  name,
  onClose,
  onRename,
}: {
  name: string;
  onClose: () => void;
  /** Resolves when the host accepted the name; a rejection keeps the dialog open. */
  onRename: (name: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hintId = useId();
  const errorId = useId();

  // The dialog has focused the field; select the old name so typing replaces it.
  useLayoutEffect(() => input.current?.select(), []);
  useEffect(() => {
    if (error && !busy) input.current?.focus();
  }, [error, busy]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const check = validateProjectName(value);
    if (!check.ok) {
      setError(check.error);
      input.current?.focus();
      return;
    }
    if (check.name === name) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onRename(check.name);
      onClose();
    } catch (caught) {
      setError(errorText(caught, "無法重新命名這個專案，請再試一次。"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="重新命名專案"
      busy={busy}
      onClose={onClose}
      initialFocus={input}
      onSubmit={(event) => void submit(event)}
      actions={
        <>
          <button
            className="k-btn k-btn--secondary k-btn--lg"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="k-btn k-btn--primary k-btn--lg"
            type="submit"
            aria-busy={busy}
            disabled={busy}
          >
            {busy ? <Icon icon={CircleNotch} spin /> : null}
            儲存名稱
          </button>
        </>
      }
    >
      <div>
        <label className="k-label" htmlFor="project-name">
          專案名稱
        </label>
        <input
          ref={input}
          id="project-name"
          className="k-input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError("");
          }}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${hintId}` : hintId}
          disabled={busy}
        />
        {error ? (
          <p className="k-error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
        <p className="k-hint" id={hintId}>
          只改 Kairomes 裡顯示的名稱，資料夾不會改名。
        </p>
      </div>
    </Dialog>
  );
}
