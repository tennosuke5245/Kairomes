import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretRight,
  CircleNotch,
  Copy,
  Eject,
  Key,
  LinkSimple,
  LockKey,
  type Icon as PhosphorIcon,
  Play,
  SidebarSimple,
  Stop,
  Timer,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { DesktopAction } from "./api.ts";
import { Icon, StatePill, StateTile, waitable } from "./components.tsx";
import {
  CONNECTION_ACTION_LABELS,
  type ConnectionAction,
  type ConnectionRow,
  keyRow,
  panelRow,
  tunnelRow,
} from "./connection-model.ts";
import { focusControl, focusHeading, focusScope } from "./focus.ts";
import { countdownUrgency, formatCountdown, PAIRING_SOON_MS } from "./format.ts";
import { type DesktopSnapshot, PROFILE_NAME } from "./model.ts";
import type { PairingLink } from "./pairing.ts";

/** The host call behind each row action, so only that button spins while it runs. */
export const CONNECTION_HOST_ACTION: Partial<Record<ConnectionAction, DesktopAction>> = {
  restart_tunnel: "restart_tunnel",
  stop_tunnel: "stop_tunnel",
  start_tunnel: "start_tunnel",
  pair: "create_pairing",
  repair: "create_pairing",
};

const ACTION_ICON: Partial<Record<ConnectionAction, PhosphorIcon>> = {
  set_key: Key,
  forget_key: Eject,
  restart_tunnel: ArrowClockwise,
  restart_runtime: ArrowClockwise,
  stop_tunnel: Stop,
  start_tunnel: Play,
  pair: LinkSimple,
  repair: LinkSimple,
};

const EXTERNAL_ACTIONS: ConnectionAction[] = ["get_key", "download_client"];

function actionClass(action: ConnectionAction, row: ConnectionRow) {
  if (action === "set_key" || action === "update_key") return "k-btn k-btn--primary k-btn--sm";
  if (action === "forget_key") return "k-btn k-btn--danger-quiet k-btn--sm";
  if (action === "get_key") return "k-btn k-btn--quiet k-btn--sm";
  // A healthy Tunnel's controls stay quiet; a recovery reads as the row's one action.
  return row.tone === "success" && (action === "restart_tunnel" || action === "stop_tunnel")
    ? "k-btn k-btn--quiet k-btn--sm"
    : "k-btn k-btn--secondary k-btn--sm";
}

/**
 * One 連線設定 row: a kind tile tinted by state, a state pill, one sentence, ≤ two actions.
 * When an action replaces its own button, focus moves to the row's new control or its title.
 */
function SettingRow({
  id,
  icon,
  title,
  row,
  busyAction,
  onAction,
  children,
}: {
  id: string;
  icon: PhosphorIcon;
  title: string;
  row: ConnectionRow;
  busyAction: string | null;
  onAction: (action: ConnectionAction, trigger: HTMLButtonElement) => void;
  children?: ReactNode;
}) {
  return (
    <section className="desk-setting" aria-labelledby={id} {...focusScope}>
      <StateTile tone={row.tone} icon={icon} />
      <div className="desk-setting__main">
        <div className="desk-setting__top">
          <div className="desk-setting__text">
            <div className="desk-setting__head">
              <h2 className="desk-setting__title" id={id} {...focusHeading}>
                {title}
              </h2>
              <StatePill tone={row.tone} icon={row.pillIcon} label={row.pill} />
            </div>
            <p className="desk-setting__meta">{row.meta}</p>
          </div>
          {row.actions.length ? (
            <div className="desk-setting__actions">
              {row.actions.map((action) => {
                const host = CONNECTION_HOST_ACTION[action];
                const running = host !== undefined && busyAction === host;
                const external = EXTERNAL_ACTIONS.includes(action);
                const lead = running ? CircleNotch : ACTION_ICON[action];
                // Host calls, key removal and the restart wait for each other; opening a page or
                // dialog never waits. A waiting button keeps keyboard focus.
                const waits =
                  host !== undefined || action === "forget_key" || action === "restart_runtime";
                return (
                  <button
                    key={action}
                    className={actionClass(action, row)}
                    type="button"
                    aria-busy={running || undefined}
                    aria-describedby={id}
                    {...focusControl}
                    {...waitable(waits && busyAction !== null, (event) =>
                      onAction(action, event.currentTarget),
                    )}
                  >
                    {lead ? <Icon icon={lead} size="sm" spin={running} /> : null}
                    {CONNECTION_ACTION_LABELS[action]}
                    {external ? <Icon icon={ArrowSquareOut} size="sm" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Screen readers hear the countdown at one minute and ten seconds, not every second. */
export function pairingAnnouncement(remainingMs: number): string {
  if (remainingMs <= 0) return "";
  if (remainingMs <= 10_000) return "配對連結剩 10 秒";
  if (remainingMs <= 60_000) return "配對連結剩 1 分鐘";
  return "";
}

export function ConnectionPage({
  snapshot,
  now,
  busyAction,
  mcpCommand,
  mcpCommandError,
  pairing,
  pairingRemainingMs,
  onAction,
  onSaveExtension,
  onCopyPairing,
  onCopyCommand,
}: {
  snapshot: DesktopSnapshot;
  now: number;
  busyAction: string | null;
  mcpCommand: string;
  mcpCommandError: string;
  pairing: PairingLink | null;
  pairingRemainingMs: number;
  onAction: (action: ConnectionAction, trigger: HTMLButtonElement) => void;
  onSaveExtension: (extensionId: string) => Promise<boolean>;
  onCopyPairing: () => void;
  onCopyCommand: () => void;
}) {
  const companion = snapshot.companion;
  const [extensionId, setExtensionId] = useState("");
  const [extensionError, setExtensionError] = useState("");
  const extensionHint = useId();
  const extensionErrorId = useId();
  const pairingLive = Boolean(pairing?.url) && pairingRemainingMs > 0;
  const configured = companion?.extension.configured === true;
  const rowProps = { busyAction, onAction };
  const key = keyRow(snapshot);
  // One primary per view: a key that still needs setting keeps it, otherwise 複製連結 takes it.
  const copyClass = key.actions.some((action) => action === "set_key" || action === "update_key")
    ? "k-btn k-btn--secondary k-btn--sm"
    : "k-btn k-btn--primary k-btn--sm";

  const submitExtension = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Enter in the field submits too; while another action runs it waits like the button.
    if (busyAction !== null) return;
    const value = extensionId.trim();
    if (!/^[a-p]{32}$/.test(value)) {
      setExtensionError("Extension ID 是 32 個 a～p 的小寫字母。");
      return;
    }
    setExtensionError("");
    if (await onSaveExtension(value)) setExtensionId("");
  };

  const extensionForm = (
    <form className="desk-inline-form" onSubmit={(event) => void submitExtension(event)} noValidate>
      {/* Inside 更換 Extension ID the summary already names the field. */}
      <label className={configured ? "k-sr-only" : "k-label"} htmlFor="extension-id">
        Extension ID
      </label>
      <div className="desk-inline-form__row">
        <input
          id="extension-id"
          className="k-input k-input--mono"
          value={extensionId}
          onChange={(event) => setExtensionId(event.target.value)}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          placeholder="貼上 32 位 Extension ID"
          aria-invalid={extensionError ? true : undefined}
          aria-describedby={extensionError ? `${extensionErrorId} ${extensionHint}` : extensionHint}
        />
        <button
          className="k-btn k-btn--secondary"
          type="submit"
          aria-busy={busyAction === "configure_extension" || undefined}
          {...waitable(busyAction !== null, () => undefined)}
        >
          <Icon
            icon={busyAction === "configure_extension" ? CircleNotch : LinkSimple}
            spin={busyAction === "configure_extension"}
          />
          儲存並配對
        </button>
      </div>
      {extensionError ? (
        <p className="k-error" id={extensionErrorId} role="alert">
          {extensionError}
        </p>
      ) : null}
      <p className="k-hint" id={extensionHint}>
        在擴充功能管理頁開啟開發人員模式即可看到 ID。
      </p>
    </form>
  );

  return (
    <div className="k-card desk-rows">
      <SettingRow id="conn-key" icon={Key} title="Runtime API Key" row={key} {...rowProps} />
      <SettingRow
        id="conn-tunnel"
        icon={LockKey}
        title="安全通道"
        row={tunnelRow(snapshot, now)}
        {...rowProps}
      >
        <details className="desk-advanced">
          <summary>
            <Icon icon={CaretRight} size="sm" />
            進階
          </summary>
          <div className="desk-command">
            <p className="k-label">本機 MCP 指令</p>
            <div className="desk-command__row">
              <code className="k-codebox desk-command__value">
                {mcpCommand || "正在取得安裝位置…"}
              </code>
              <button
                className="k-btn k-btn--secondary k-btn--sm"
                type="button"
                disabled={!mcpCommand}
                onClick={onCopyCommand}
              >
                <Icon icon={Copy} size="sm" />
                複製指令
              </button>
            </div>
            {mcpCommandError ? (
              <p className="k-error" role="alert">
                {mcpCommandError}
              </p>
            ) : (
              <p className="k-hint">
                建立 {PROFILE_NAME} profile 時填入 <code className="desk-flag">--mcp-command</code>
                ，只需設定一次；指令不含金鑰或配對資訊。
              </p>
            )}
          </div>
        </details>
      </SettingRow>
      <SettingRow
        id="conn-panel"
        icon={SidebarSimple}
        title="瀏覽器側欄"
        row={panelRow(snapshot, { live: pairingLive, cleared: Boolean(pairing && !pairingLive) })}
        {...rowProps}
      >
        {pairingLive ? (
          <div className="desk-pairing">
            <span className="desk-pairing__code">
              配對連結 <span aria-hidden="true">••••••••</span>
              <span className="k-sr-only">（已隱藏）</span>
            </span>
            <span
              className="k-countdown k-countdown--pill"
              data-urgency={countdownUrgency(pairingRemainingMs, PAIRING_SOON_MS)}
            >
              <Icon icon={Timer} />
              {formatCountdown(pairingRemainingMs)}
            </span>
            <button className={copyClass} type="button" onClick={onCopyPairing} {...focusControl}>
              <Icon icon={Copy} size="sm" />
              複製連結
            </button>
            <p className="k-hint desk-pairing__hint">只貼到瀏覽器側欄，勿交給 ChatGPT。</p>
          </div>
        ) : null}
        <div role="status" className="desk-pairing__status">
          {pairing?.cleared === "expired" ? (
            <p className="k-hint">配對連結已過期；需要時再重新產生。</p>
          ) : null}
          <span className="k-sr-only">
            {pairingLive ? pairingAnnouncement(pairingRemainingMs) : ""}
          </span>
        </div>
        {!companion ? null : configured ? (
          <details className="desk-advanced">
            <summary>
              <Icon icon={CaretRight} size="sm" />
              更換 Extension ID
            </summary>
            {extensionForm}
          </details>
        ) : (
          extensionForm
        )}
      </SettingRow>
    </div>
  );
}
