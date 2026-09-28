type ProcessState = "starting" | "running" | "error" | "stopped";

export type WorkspaceSummary = {
  id: string;
  name: string;
  capabilities: string[];
};

type CompanionStatus = {
  version: string;
  overall: { tone: "good" | "warn" | "busy"; label: string };
  workspaces: WorkspaceSummary[];
  workbench: {
    state: "starting" | "running" | "external" | "stopped" | "error";
    label: string;
    message: string;
    meta: string;
  };
  tunnel: {
    state: "missing" | "starting" | "running" | "stopped" | "error";
    label: string;
    message: string;
    meta: string;
    logs: string[];
  };
  connector: {
    state: "connected" | "waiting" | "blocked";
    label: string;
    message: string;
    meta: string;
  };
  extension: { configured: boolean };
};

export type DesktopSnapshot = {
  credentialConfigured: boolean;
  tunnelClientInstalled: boolean;
  runtime: {
    state: ProcessState;
    owned: boolean;
    message: string;
  };
  companion: CompanionStatus | null;
};

export type PrimaryAction =
  | "configure_key"
  | "start_tunnel"
  | "restart_runtime"
  | "open_connectors"
  | "open_workbench"
  | "show_tunnel_help"
  | "add_workspace"
  | "none";

type DesktopView = {
  tone: "ready" | "focus" | "waiting" | "error";
  title: string;
  description: string;
  action: PrimaryAction;
  actionLabel: string;
  localState: "done" | "current" | "pending" | "error";
  tunnelState: "done" | "current" | "pending" | "error";
  chatgptState: "done" | "current" | "pending" | "error";
};

export function deriveDesktopView(snapshot: DesktopSnapshot): DesktopView {
  if (snapshot.runtime.state === "error") {
    return {
      tone: "error",
      title: "本機服務未啟動",
      description: snapshot.runtime.message || "重新啟動本機服務，Kairomes 會保留你的設定。",
      action: "restart_runtime",
      actionLabel: "重新啟動",
      localState: "error",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (!snapshot.credentialConfigured) {
    return {
      tone: "focus",
      title: "連上 ChatGPT",
      description: "設定 Runtime API Key；金鑰會由作業系統保管。",
      action: "configure_key",
      actionLabel: "設定安全連線",
      localState: snapshot.companion ? "done" : "current",
      tunnelState: "current",
      chatgptState: "pending",
    };
  }

  if (!snapshot.companion || snapshot.runtime.state === "starting") {
    return {
      tone: "waiting",
      title: "正在啟動本機服務",
      description: "通常只需要幾秒。",
      action: "none",
      actionLabel: "正在啟動",
      localState: "current",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (!["running", "external"].includes(snapshot.companion.workbench.state)) {
    return {
      tone: "error",
      title: "工作台暫時無法使用",
      description: snapshot.companion.workbench.message,
      action: "restart_runtime",
      actionLabel: "重新啟動",
      localState: "error",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.workspaces?.length === 0) {
    return {
      tone: "focus",
      title: "加入第一個專案",
      description: "選擇本機資料夾；檔案不會被搬移或上傳。",
      action: "add_workspace",
      actionLabel: "選擇專案資料夾",
      localState: "current",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.tunnel.state === "missing" || !snapshot.tunnelClientInstalled) {
    return {
      tone: "error",
      title: "找不到 ChatGPT Tunnel",
      description: "Kairomes 已經在本機準備好，但還需要官方 tunnel-client 才能交給 ChatGPT 使用。",
      action: "show_tunnel_help",
      actionLabel: "查看安裝說明",
      localState: "done",
      tunnelState: "error",
      chatgptState: "pending",
    };
  }

  if (["error", "stopped"].includes(snapshot.companion.tunnel.state)) {
    return {
      tone: snapshot.companion.tunnel.state === "error" ? "error" : "focus",
      title: snapshot.companion.tunnel.state === "error" ? "Tunnel 連線失敗" : "安全連線已暫停",
      description: snapshot.companion.tunnel.message,
      action: "start_tunnel",
      actionLabel: "啟動安全連線",
      localState: "done",
      tunnelState: snapshot.companion.tunnel.state === "error" ? "error" : "current",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.tunnel.state === "starting") {
    return {
      tone: "waiting",
      title: "正在連線 ChatGPT",
      description: "完成後會自動更新。",
      action: "none",
      actionLabel: "正在連線",
      localState: "done",
      tunnelState: "current",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.connector.state !== "connected") {
    return {
      tone: "waiting",
      title: "重新整理 Kairomes Connector",
      description: "到 ChatGPT 設定中重新整理，讓新工具出現。",
      action: "open_connectors",
      actionLabel: "開啟 ChatGPT 設定",
      localState: "done",
      tunnelState: "done",
      chatgptState: "current",
    };
  }

  return {
    tone: "ready",
    title: "已連上 ChatGPT",
    description: "Kairomes 會在背景守著連線；只有需要你決定的事情，才會把視窗叫回來。",
    action: "open_workbench",
    actionLabel: "開啟工作台",
    localState: "done",
    tunnelState: "done",
    chatgptState: "done",
  };
}
