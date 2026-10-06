use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, UserAttentionType, WindowEvent, Wry,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::Notify;

const DESKTOP_VERSION: &str = env!("CARGO_PKG_VERSION");
const KEYRING_SERVICE: &str = "dev.tennosuke.kairomes";
const KEYRING_ACCOUNT: &str = "control-plane-api-key";
const CONNECTION_FILE: &str = "companion-connection.json";
const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "kairomes-tray";
/// Pushed after every status collection; the payload is the same JSON as `get_desktop_status`.
const STATUS_EVENT: &str = "desktop-status";
/// Asks the UI to confirm a runtime restart requested from the tray.
const CONFIRM_RESTART_EVENT: &str = "desktop-confirm-restart";
const VISIBLE_STATUS_INTERVAL: Duration = Duration::from_secs(2);
const HIDDEN_STATUS_INTERVAL: Duration = Duration::from_secs(6);
const TUNNEL_CLIENT_RECHECK: Duration = Duration::from_secs(30);
const COMPANION_TIMEOUT: Duration = Duration::from_secs(4);
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(30);

/// Companion actions the webview may request through `perform_action`. Everything else, such
/// as quit, workspace changes or Extension configuration, has its own validated command or is
/// not reachable from the webview at all.
const COMPANION_ACTIONS: [&str; 7] = [
    "open_workbench",
    "open_connectors",
    "retry_workbench",
    "start_tunnel",
    "stop_tunnel",
    "restart_tunnel",
    "create_pairing",
];

struct OwnedRuntime {
    generation: u64,
    child: CommandChild,
}

struct RuntimeState {
    process: Mutex<Option<OwnedRuntime>>,
    last_error: Mutex<Option<String>>,
    quitting: AtomicBool,
    generation: AtomicU64,
    /// Serializes spawn, restart and quit so the status loop never races a restart.
    lifecycle: tokio::sync::Mutex<()>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            last_error: Mutex::new(None),
            quitting: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }
}

/// What the tray and attention signals last reflected.
#[derive(Default)]
struct PublishedStatus {
    sequence: u64,
    /// Last known pending approval count; an unknown count keeps the previous value.
    pending: u64,
    tray: Option<TrayStatus>,
    workbench_ready: Option<bool>,
}

#[derive(Default)]
struct StatusState {
    sequence: AtomicU64,
    /// Whether the OS keyring holds a Runtime API Key. Only presence is cached, never the key.
    credential: Mutex<Option<bool>>,
    tunnel_client: Mutex<Option<(bool, Instant)>>,
    published: Mutex<PublishedStatus>,
    wake: Notify,
}

struct TrayMenu {
    workbench: MenuItem<Wry>,
}

/// Never derive Debug: the token must not be printable.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionConnection {
    instance_id: String,
    pid: u32,
    origin: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSnapshot {
    /// The Desktop app version.
    version: &'static str,
    /// Increases with every collection in this Desktop process; larger is newer.
    sequence: u64,
    credential_configured: bool,
    tunnel_client_installed: bool,
    runtime: DesktopRuntime,
    companion: Option<Value>,
    /// The Companion differs from Desktop, or its workbench differs from the Companion.
    version_mismatch: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntime {
    state: &'static str,
    owned: bool,
    message: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_in_seconds: Option<u64>,
}

/// Desktop-only absolute project root. It never reaches MCP, the widget or the Extension.
#[derive(Debug, PartialEq, Serialize)]
struct WorkspacePath {
    id: String,
    root: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayStatus {
    Starting,
    Setup,
    Problem,
    Pending(u64),
    Paused,
    Connecting,
    Waiting,
    Ready,
}

fn runtime_state(app: &AppHandle) -> State<'_, RuntimeState> {
    app.state::<RuntimeState>()
}

fn status_state(app: &AppHandle) -> State<'_, StatusState> {
    app.state::<StatusState>()
}

fn lock_error() -> String {
    "Kairomes 內部狀態暫時無法存取。".to_string()
}

/// Caps a message at `max` bytes on a character boundary; `String::truncate` would panic
/// inside a multi-byte character such as CJK sidecar output.
fn truncate_message(mut message: String, max: usize) -> String {
    if message.len() > max {
        let mut end = max;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    message
}

fn set_runtime_error(app: &AppHandle, message: impl Into<String>) {
    let message = truncate_message(message.into(), 320);
    if let Ok(mut slot) = runtime_state(app).last_error.lock() {
        *slot = Some(message);
    }
}

fn clear_runtime_error(app: &AppHandle) {
    if let Ok(mut slot) = runtime_state(app).last_error.lock() {
        *slot = None;
    }
}

fn data_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Kairomes"))
            .ok_or_else(|| "找不到 Windows 本機應用程式資料夾。".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(path).join("Kairomes"));
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".local").join("share").join("Kairomes"))
            .ok_or_else(|| "找不到本機應用程式資料夾。".to_string())
    }
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("無法開啟作業系統憑證保管庫：{error}"))
}

fn load_runtime_api_key() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("無法讀取作業系統憑證保管庫：{error}")),
    }
}

fn remember_credential(app: &AppHandle, present: bool) {
    if let Ok(mut slot) = status_state(app).credential.lock() {
        *slot = Some(present);
    }
}

/// Keyring presence, read once and refreshed on save, forget and every runtime spawn.
fn credential_configured(app: &AppHandle) -> Result<bool, String> {
    if let Some(present) = status_state(app)
        .credential
        .lock()
        .ok()
        .and_then(|slot| *slot)
    {
        return Ok(present);
    }
    let present = load_runtime_api_key()?.is_some();
    remember_credential(app, present);
    Ok(present)
}

fn cached<T: Copy>(slot: Option<(T, Instant)>, now: Instant, ttl: Duration) -> Option<T> {
    slot.filter(|(_, checked)| now.saturating_duration_since(*checked) < ttl)
        .map(|(value, _)| value)
}

/// PATH lookup for tunnel-client, repeated at most every 30 seconds.
fn tunnel_client_installed(app: &AppHandle) -> bool {
    let state = status_state(app);
    let now = Instant::now();
    if let Some(installed) = state
        .tunnel_client
        .lock()
        .ok()
        .and_then(|slot| cached(*slot, now, TUNNEL_CLIENT_RECHECK))
    {
        return installed;
    }
    let installed = which::which("tunnel-client").is_ok();
    if let Ok(mut slot) = state.tunnel_client.lock() {
        *slot = Some((installed, now));
    }
    installed
}

fn forget_tunnel_client_check(app: &AppHandle) {
    if let Ok(mut slot) = status_state(app).tunnel_client.lock() {
        *slot = None;
    }
}

fn wake_status_loop(app: &AppHandle) {
    status_state(app).wake.notify_one();
}

/// Strict descriptor validation: loopback http origin with a port, 64-hex token, real pid.
fn parse_connection(bytes: &[u8]) -> Result<CompanionConnection, String> {
    let connection: CompanionConnection = serde_json::from_slice(bytes)
        .map_err(|_| "Kairomes 本機連線描述檔格式不正確。".to_string())?;
    let origin =
        Url::parse(&connection.origin).map_err(|_| "Kairomes 本機連線來源不正確。".to_string())?;
    let valid_origin = origin.scheme() == "http"
        && origin.host_str() == Some("127.0.0.1")
        && origin.port().is_some()
        && origin.path() == "/"
        && origin.query().is_none()
        && origin.fragment().is_none()
        && origin.username().is_empty()
        && origin.password().is_none()
        && !connection.origin.ends_with('/');
    let valid_token = connection.token.len() == 64
        && connection
            .token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !valid_origin || !valid_token || connection.pid == 0 || connection.instance_id.is_empty() {
        return Err("Kairomes 本機連線描述檔驗證失敗。".to_string());
    }
    Ok(connection)
}

fn read_connection() -> Result<CompanionConnection, String> {
    let path = data_directory()?.join(CONNECTION_FILE);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Kairomes 本機服務尚未建立連線。".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("Kairomes 本機連線描述檔不安全或已損壞。".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "無法讀取 Kairomes 本機連線描述檔。".to_string())?;
    parse_connection(&bytes)
}

/// One loopback-only client for every Companion call. It never follows redirects and never
/// uses a system proxy, so the control token cannot leave the machine.
fn http_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .timeout(COMPANION_TIMEOUT)
        .build()
        .map_err(|error| format!("無法建立本機控制連線：{error}"))?;
    Ok(CLIENT.get_or_init(|| client))
}

async fn companion_request(path: &str, body: Value) -> Result<Value, String> {
    let connection = read_connection()?;
    let response = http_client()?
        .post(format!("{}{}", connection.origin, path))
        .header("Origin", &connection.origin)
        .bearer_auth(&connection.token)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Kairomes 本機服務尚未回應。".to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Kairomes 本機服務回應格式不正確。".to_string())?;
    if !status.is_success() {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Kairomes 本機操作失敗。")
            .to_string());
    }
    Ok(value)
}

async fn companion_status() -> Option<Value> {
    companion_request("/api/status", json!({})).await.ok()
}

fn process_is_owned(app: &AppHandle) -> Result<bool, String> {
    let state = runtime_state(app);
    state
        .process
        .lock()
        .map(|slot| slot.is_some())
        .map_err(|_| lock_error())
}

fn runtime_error(app: &AppHandle) -> Option<String> {
    let state = runtime_state(app);
    state.last_error.lock().ok().and_then(|slot| slot.clone())
}

fn format_local_mcp_command(path: &str, windows_path: bool) -> Result<String, String> {
    if path.contains('"') {
        return Err("Kairomes 安裝路徑含有不支援的引號。".to_string());
    }
    // tunnel-client init parses --mcp-command with shell-style escaping.
    // Forward slashes keep Windows paths intact when the profile is initialized.
    let command_path = if windows_path {
        path.replace('\\', "/")
    } else {
        path.to_string()
    };
    Ok(format!("\"{command_path}\" relay --stdio"))
}

#[tauri::command]
fn get_local_mcp_command() -> Result<String, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("無法取得 Kairomes 安裝位置：{error}"))?;
    let exe_dir = executable
        .parent()
        .ok_or_else(|| "無法取得 Kairomes 安裝資料夾。".to_string())?;
    // Match tauri-plugin-shell's sidecar path resolution, including Rust tests.
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };
    let sidecar = base_dir.join(format!("kairomes-runtime{}", std::env::consts::EXE_SUFFIX));
    if !sidecar.is_file() {
        return Err("找不到 Kairomes 本機服務；請重新安裝或重新建置 Desktop。".to_string());
    }
    let path = sidecar
        .to_str()
        .ok_or_else(|| "Kairomes 安裝路徑無法用於 Tunnel 指令。".to_string())?;
    format_local_mcp_command(path, cfg!(windows))
}

async fn spawn_runtime(app: &AppHandle) -> Result<(), String> {
    if runtime_state(app).quitting.load(Ordering::SeqCst)
        || process_is_owned(app)?
        || companion_status().await.is_some()
    {
        return Ok(());
    }

    let api_key = load_runtime_api_key()?;
    remember_credential(app, api_key.is_some());
    let mut command = app
        .shell()
        .sidecar("kairomes-runtime")
        .map_err(|error| format!("找不到 Kairomes 本機服務：{error}"))?
        .args(["--no-open"]);
    if let Some(key) = api_key.as_deref() {
        command = command.env("CONTROL_PLANE_API_KEY", key);
    } else {
        command = command.arg("--no-tunnel");
    }

    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("無法啟動 Kairomes 本機服務：{error}"))?;
    let generation = runtime_state(app).generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let state = runtime_state(app);
        let mut slot = state.process.lock().map_err(|_| lock_error())?;
        *slot = Some(OwnedRuntime { generation, child });
    }
    clear_runtime_error(app);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Error(message) => set_runtime_error(&handle, message),
                CommandEvent::Terminated(payload) => {
                    let is_current = {
                        let state = runtime_state(&handle);
                        state
                            .process
                            .lock()
                            .map(|mut slot| {
                                if slot
                                    .as_ref()
                                    .is_some_and(|owned| owned.generation == generation)
                                {
                                    *slot = None;
                                    true
                                } else {
                                    false
                                }
                            })
                            .unwrap_or(false)
                    };
                    if is_current && !runtime_state(&handle).quitting.load(Ordering::SeqCst) {
                        let suffix = payload
                            .code
                            .map(|code| format!("（Exit {code}）"))
                            .unwrap_or_default();
                        set_runtime_error(&handle, format!("Kairomes 本機服務已停止{suffix}。"));
                        wake_status_loop(&handle);
                    }
                    break;
                }
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !message.is_empty() {
                        set_runtime_error(&handle, message);
                    }
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Starts the bundled runtime when nothing answers, Desktop owns no process and no failure is
/// waiting for the user. A spawn or restart already in progress wins.
async fn ensure_runtime(app: &AppHandle) {
    let state = runtime_state(app);
    if state.quitting.load(Ordering::SeqCst)
        || process_is_owned(app).unwrap_or(true)
        || runtime_error(app).is_some()
    {
        return;
    }
    let Ok(_lifecycle) = state.lifecycle.try_lock() else {
        return;
    };
    if let Err(error) = spawn_runtime(app).await {
        set_runtime_error(app, error);
    }
}

fn take_owned_runtime(app: &AppHandle) -> Option<CommandChild> {
    let state = runtime_state(app);
    state.generation.fetch_add(1, Ordering::SeqCst);
    state
        .process
        .lock()
        .ok()
        .and_then(|mut slot| slot.take().map(|owned| owned.child))
}

async fn stop_runtime(app: &AppHandle, include_external: bool) {
    let owned = process_is_owned(app).unwrap_or(false);
    if owned || include_external {
        let _ = companion_request("/api/action", json!({ "action": "quit" })).await;
    }
    tokio::time::sleep(Duration::from_millis(220)).await;
    if let Some(child) = take_owned_runtime(app) {
        let _ = child.kill();
    }
}

async fn restart_runtime(app: &AppHandle) -> Result<(), String> {
    let state = runtime_state(app);
    let _lifecycle = state.lifecycle.lock().await;
    clear_runtime_error(app);
    // Restart is an explicit takeover action. A normal Desktop quit never stops
    // a Companion that was started by another owner.
    stop_runtime(app, true).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    let result = spawn_runtime(app).await;
    wake_status_loop(app);
    result
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |current, key| current.get(key))
        .and_then(Value::as_str)
}

fn desktop_runtime(companion_answered: bool, owned: bool, error: Option<String>) -> DesktopRuntime {
    if companion_answered {
        DesktopRuntime {
            state: "running",
            owned,
            message: if owned {
                "本機服務由 Kairomes Desktop 管理。".to_string()
            } else {
                "已接上既有的 Kairomes 本機服務。".to_string()
            },
        }
    } else if let Some(error) = error {
        DesktopRuntime {
            state: "error",
            owned,
            message: error,
        }
    } else {
        DesktopRuntime {
            state: "starting",
            owned,
            message: "正在啟動本機服務。".to_string(),
        }
    }
}

/// An older or newer Companion, or a Companion attached to a workbench of another version.
fn version_mismatch(desktop_version: &str, companion: &Value) -> bool {
    str_at(companion, &["version"]) != Some(desktop_version)
        || companion
            .get("versionMismatch")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn pending_total(snapshot: &DesktopSnapshot) -> Option<u64> {
    snapshot
        .companion
        .as_ref()?
        .get("attention")?
        .get("pending")?
        .get("total")?
        .as_u64()
}

fn workbench_ready(snapshot: &DesktopSnapshot) -> bool {
    snapshot.companion.as_ref().is_some_and(|companion| {
        matches!(
            str_at(companion, &["workbench", "state"]),
            Some("running" | "external")
        )
    })
}

/// One tray state per snapshot; pending approvals outrank everything once the service answers.
fn tray_status(snapshot: &DesktopSnapshot) -> TrayStatus {
    if snapshot.runtime.state == "error" {
        return TrayStatus::Problem;
    }
    let Some(companion) = snapshot.companion.as_ref() else {
        return TrayStatus::Starting;
    };
    if let Some(pending) = pending_total(snapshot).filter(|count| *count > 0) {
        return TrayStatus::Pending(pending);
    }
    if !snapshot.credential_configured {
        return TrayStatus::Setup;
    }
    match str_at(companion, &["workbench", "state"]) {
        Some("running" | "external") => {}
        Some("starting") => return TrayStatus::Starting,
        _ => return TrayStatus::Problem,
    }
    if companion
        .get("workspaces")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        return TrayStatus::Setup;
    }
    if snapshot.version_mismatch || !snapshot.tunnel_client_installed {
        return TrayStatus::Problem;
    }
    match str_at(companion, &["tunnel", "state"]) {
        Some("running") if str_at(companion, &["connector", "state"]) == Some("connected") => {
            TrayStatus::Ready
        }
        Some("running") => TrayStatus::Waiting,
        Some("starting") => TrayStatus::Connecting,
        Some("stopped") => TrayStatus::Paused,
        Some("error")
            if companion
                .get("tunnel")
                .and_then(|tunnel| tunnel.get("nextRetryAt"))
                .is_some_and(Value::is_string) =>
        {
            TrayStatus::Connecting
        }
        _ => TrayStatus::Problem,
    }
}

/// Tray tooltip: a fixed label plus a count, never a path, name or message.
fn tray_tooltip(status: TrayStatus) -> String {
    let detail = match status {
        TrayStatus::Starting => "正在啟動".to_string(),
        TrayStatus::Setup => "尚未完成設定".to_string(),
        TrayStatus::Problem => "需要處理".to_string(),
        TrayStatus::Pending(count) if count > 99 => "需確認 99+".to_string(),
        TrayStatus::Pending(count) => format!("需確認 {count}"),
        TrayStatus::Paused => "安全連線已暫停".to_string(),
        TrayStatus::Connecting => "正在連線".to_string(),
        TrayStatus::Waiting => "等待 ChatGPT".to_string(),
        TrayStatus::Ready => "已就緒".to_string(),
    };
    format!("Kairomes · {detail}")
}

/// Pending approvals appeared while nobody is looking at the window.
fn should_request_attention(
    previous_pending: u64,
    next_pending: Option<u64>,
    attended: bool,
) -> bool {
    !attended && previous_pending == 0 && next_pending.is_some_and(|count| count > 0)
}

fn status_interval(attended: bool) -> Duration {
    if attended {
        VISIBLE_STATUS_INTERVAL
    } else {
        HIDDEN_STATUS_INTERVAL
    }
}

/// Visible and not minimized. A hidden (tray) or minimized window is polled less often.
fn window_attended(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW).is_some_and(|window| {
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    })
}

/// Reads the Companion and cached local facts. It never spawns or restarts anything.
async fn collect_status(app: &AppHandle) -> Result<DesktopSnapshot, String> {
    let sequence = status_state(app).sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let companion = companion_status().await;
    let owned = process_is_owned(app)?;
    let runtime = desktop_runtime(companion.is_some(), owned, runtime_error(app));
    let version_mismatch = companion
        .as_ref()
        .is_some_and(|companion| version_mismatch(DESKTOP_VERSION, companion));
    Ok(DesktopSnapshot {
        version: DESKTOP_VERSION,
        sequence,
        credential_configured: credential_configured(app)?,
        tunnel_client_installed: tunnel_client_installed(app),
        runtime,
        companion,
        version_mismatch,
    })
}

/// Updates the tray, raises attention on a 0→n pending transition and pushes the snapshot.
/// A collection that finished after a newer one was published is dropped here.
fn publish_status(app: &AppHandle, snapshot: &DesktopSnapshot) {
    let attended = window_attended(app);
    let next_pending = pending_total(snapshot);
    let tray = tray_status(snapshot);
    let ready = workbench_ready(snapshot);
    let (attention, tray_changed, menu_changed) = {
        let state = status_state(app);
        let Ok(mut published) = state.published.lock() else {
            return;
        };
        if snapshot.sequence < published.sequence {
            return;
        }
        published.sequence = snapshot.sequence;
        let attention = should_request_attention(published.pending, next_pending, attended);
        if let Some(count) = next_pending {
            published.pending = count;
        }
        let tray_changed = published.tray.replace(tray) != Some(tray);
        let menu_changed = published.workbench_ready.replace(ready) != Some(ready);
        (attention, tray_changed, menu_changed)
    };
    if tray_changed {
        if let Some(icon) = app.tray_by_id(TRAY_ID) {
            let _ = icon.set_tooltip(Some(tray_tooltip(tray)));
        }
    }
    if menu_changed {
        if let Some(menu) = app.try_state::<TrayMenu>() {
            let _ = menu.workbench.set_enabled(ready);
        }
    }
    if attention {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
    let _ = app.emit_to(MAIN_WINDOW, STATUS_EVENT, snapshot);
}

/// About every 2 s while the window is visible and 6 s while it is hidden or minimized; showing
/// or focusing the window wakes it at once.
fn start_status_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        while !runtime_state(&app).quitting.load(Ordering::SeqCst) {
            let attended = window_attended(&app);
            let needs_runtime = match collect_status(&app).await {
                Ok(snapshot) => {
                    publish_status(&app, &snapshot);
                    snapshot.companion.is_none()
                }
                // A keyring failure still starts the runtime, which then reports the error.
                Err(_) => true,
            };
            if needs_runtime {
                ensure_runtime(&app).await;
            }
            let state = status_state(&app);
            let _ = tokio::time::timeout(status_interval(attended), state.wake.notified()).await;
        }
    });
}

/// Immediate read for first paint and after actions; the status loop pushes later updates.
#[tauri::command]
async fn get_desktop_status(app: AppHandle) -> Result<DesktopSnapshot, String> {
    let snapshot = collect_status(&app).await?;
    publish_status(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn save_runtime_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    let value = api_key.trim();
    if value.len() < 8 || value.len() > 2048 || value.chars().any(char::is_whitespace) {
        return Err("Runtime API Key 格式不正確。".to_string());
    }
    keyring_entry()?
        .set_password(value)
        .map_err(|error| format!("無法把金鑰保存到作業系統憑證保管庫：{error}"))?;
    remember_credential(&app, true);
    restart_runtime(&app).await
}

#[tauri::command]
async fn forget_runtime_api_key(app: AppHandle) -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(format!("無法從作業系統憑證保管庫移除金鑰：{error}")),
    }
    remember_credential(&app, false);
    restart_runtime(&app).await
}

fn pairing_url(value: &Value) -> Option<String> {
    value
        .get("pairingUrl")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn pairing_result(value: &Value) -> ActionResult {
    ActionResult {
        pairing_url: pairing_url(value),
        expires_in_seconds: value
            .get("expiresInSeconds")
            .and_then(Value::as_u64)
            .filter(|seconds| (1..=3600).contains(seconds)),
    }
}

fn companion_action(action: &str) -> Option<&'static str> {
    COMPANION_ACTIONS
        .iter()
        .copied()
        .find(|allowed| *allowed == action)
}

#[tauri::command]
async fn perform_action(app: AppHandle, action: String) -> Result<ActionResult, String> {
    if action == "restart_runtime" {
        restart_runtime(&app).await?;
        return Ok(ActionResult::default());
    }
    let action = companion_action(&action).ok_or_else(|| "不支援的 Kairomes 操作。".to_string())?;
    if matches!(action, "start_tunnel" | "restart_tunnel") {
        // The user may just have installed tunnel-client; check PATH again on the next read.
        forget_tunnel_client_check(&app);
    }
    let value = companion_request("/api/action", json!({ "action": action })).await?;
    wake_status_loop(&app);
    Ok(pairing_result(&value))
}

#[tauri::command]
async fn configure_extension(extension_id: String) -> Result<ActionResult, String> {
    let value = extension_id.trim();
    if value.len() != 32 || !value.bytes().all(|byte| (b'a'..=b'p').contains(&byte)) {
        return Err("Extension ID 應為 32 個 a～p 字元。".to_string());
    }
    let response = companion_request(
        "/api/action",
        json!({ "action": "configure_extension", "extensionId": value }),
    )
    .await?;
    Ok(pairing_result(&response))
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

#[tauri::command]
async fn add_workspace(path: String, name: Option<String>) -> Result<Value, String> {
    if path.trim().is_empty() || path.len() > 32767 {
        return Err("請選擇有效的專案資料夾。".to_string());
    }
    let mut body = json!({ "action": "workspace_add", "path": path });
    if let Some(name) = name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        if name.len() > 1024 {
            return Err("專案名稱須為 1～80 個字元。".to_string());
        }
        body["name"] = json!(name);
    }
    let response = companion_request("/api/action", body).await?;
    response
        .get("workspace")
        .cloned()
        .ok_or_else(|| "Kairomes 沒有回傳新增的專案。".to_string())
}

#[tauri::command]
async fn rename_workspace(workspace_id: String, name: String) -> Result<Value, String> {
    if !is_uuid(&workspace_id) {
        return Err("找不到這個專案。".to_string());
    }
    // The Companion validates the name strictly; this only bounds the request size.
    let name = name.trim();
    if name.is_empty() || name.len() > 1024 {
        return Err("專案名稱須為 1～80 個字元。".to_string());
    }
    let response = companion_request(
        "/api/action",
        json!({ "action": "workspace_rename", "workspace_id": workspace_id, "name": name }),
    )
    .await?;
    response
        .get("workspace")
        .cloned()
        .ok_or_else(|| "Kairomes 沒有回傳重新命名的專案。".to_string())
}

fn parse_workspace_paths(response: &Value) -> Result<Vec<WorkspacePath>, String> {
    let invalid = || "Kairomes 沒有回傳專案資料。".to_string();
    response
        .get("workspaces")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?
        .iter()
        .map(|item| {
            let id = str_at(item, &["id"]).filter(|id| is_uuid(id));
            let root =
                str_at(item, &["root"]).filter(|root| !root.is_empty() && root.len() <= 32767);
            match (id, root) {
                (Some(id), Some(root)) => Ok(WorkspacePath {
                    id: id.to_string(),
                    root: root.to_string(),
                }),
                _ => Err(invalid()),
            }
        })
        .collect()
}

/// Absolute roots come only from the Companion's Desktop-only details action.
async fn workspace_paths() -> Result<Vec<WorkspacePath>, String> {
    let response =
        companion_request("/api/action", json!({ "action": "workspace_details" })).await?;
    parse_workspace_paths(&response)
}

/// Desktop-only project roots for display. They are never forwarded to MCP, the widget,
/// the Extension or logs.
#[tauri::command]
async fn get_workspace_paths() -> Result<Vec<WorkspacePath>, String> {
    workspace_paths().await
}

/// A registered root that is still a real directory. Links are refused so a replaced root
/// never reveals some other location.
fn revealable_root(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    let missing = || "找不到專案資料夾；它可能已被移動或刪除。".to_string();
    if !path.is_absolute() {
        return Err(missing());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| missing())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(missing());
    }
    Ok(path)
}

/// Shows a mounted project in the OS file manager. The webview sends only the opaque id; the
/// root is resolved here from the Companion registry.
#[tauri::command]
async fn reveal_workspace(app: AppHandle, workspace_id: String) -> Result<(), String> {
    if !is_uuid(&workspace_id) {
        return Err("找不到這個專案。".to_string());
    }
    let workspace = workspace_paths()
        .await?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| "找不到這個專案。".to_string())?;
    let root = revealable_root(&workspace.root)?;
    app.opener()
        .reveal_item_in_dir(root)
        .map_err(|_| "無法在檔案總管中顯示專案資料夾。".to_string())
}

/// Fixed-id checks plus a copyable summary that holds only enums, counts and versions.
#[tauri::command]
async fn get_diagnostics(app: AppHandle) -> Result<Value, String> {
    forget_tunnel_client_check(&app);
    let response = companion_request("/api/action", json!({ "action": "diagnostics" })).await?;
    match (response.get("checks"), response.get("summary")) {
        (Some(checks), Some(summary)) if checks.is_array() && summary.is_string() => {
            Ok(json!({ "checks": checks, "summary": summary }))
        }
        _ => Err("Kairomes 沒有回傳診斷結果。".to_string()),
    }
}

#[tauri::command]
async fn remove_workspace(workspace_id: String) -> Result<(), String> {
    if !is_uuid(&workspace_id) {
        return Err("找不到這個專案。".to_string());
    }
    companion_request(
        "/api/action",
        json!({ "action": "workspace_remove", "workspaceId": workspace_id }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn handoff_request(input: Value) -> Result<Value, String> {
    // Zod strictly validates the action at the trusted Companion. No generic route,
    // source home, RPC method or control credential is accepted from the webview.
    let encoded = serde_json::to_vec(&input).map_err(|_| "接續請求格式不正確。".to_string())?;
    if encoded.len() > 64 * 1024 {
        return Err("接續請求超過大小上限。".to_string());
    }
    let connection = read_connection()?;
    let response = http_client()
        .map_err(|_| "無法建立接續連線。".to_string())?
        .post(format!("{}/api/handoff", connection.origin))
        .timeout(HANDOFF_TIMEOUT)
        .header("Origin", &connection.origin)
        .bearer_auth(&connection.token)
        .json(&input)
        .send()
        .await
        .map_err(|_| "接續來源未回應，請重新建立草稿。".to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "接續回應格式不正確。".to_string())?;
    if !status.is_success() {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("無法完成接續核對。")
            .to_string());
    }
    Ok(value)
}

/// The only external pages Desktop opens. The webview names a target; it never sends a URL.
fn external_url(target: &str) -> Option<&'static str> {
    match target {
        "runtime_keys" => Some("https://platform.openai.com/settings/organization/api-keys"),
        "chatgpt_connectors" => Some("https://chatgpt.com/#settings/Connectors"),
        "tunnel_guide" => Some("https://developers.openai.com/api/docs/guides/secure-mcp-tunnels"),
        "tunnel_releases" => Some("https://github.com/openai/tunnel-client/releases/latest"),
        "platform_tunnels" => Some("https://platform.openai.com/settings/organization/tunnels"),
        "kairomes_releases" => Some("https://github.com/tennosuke5245/Kairomes/releases"),
        _ => None,
    }
}

#[tauri::command]
fn open_external(app: AppHandle, target: String) -> Result<(), String> {
    let url = external_url(&target).ok_or_else(|| "不支援的外部連結。".to_string())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("無法開啟瀏覽器：{error}"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    wake_status_loop(app);
}

async fn quit_application(app: AppHandle) {
    runtime_state(&app).quitting.store(true, Ordering::SeqCst);
    wake_status_loop(&app);
    {
        let state = runtime_state(&app);
        let _lifecycle = state.lifecycle.lock().await;
        stop_runtime(&app, false).await;
    }
    app.exit(0);
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "開啟 Kairomes").build(app)?;
    let workbench = MenuItemBuilder::with_id("workbench", "開啟工作台")
        .enabled(false)
        .build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重新啟動本機服務").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "結束 Kairomes").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &workbench, &restart, &separator, &quit])
        .build()?;
    app.manage(TrayMenu {
        workbench: workbench.clone(),
    });
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tray_tooltip(TrayStatus::Starting))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "workbench" => {
                tauri::async_runtime::spawn(async move {
                    let _ = companion_request("/api/action", json!({ "action": "open_workbench" }))
                        .await;
                });
            }
            "restart" => {
                // Restarting stops terminals, grants and MCP logins, so the UI confirms first.
                show_main_window(app);
                let _ = app.emit_to(MAIN_WINDOW, CONFIRM_RESTART_EVENT, ());
            }
            "quit" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(quit_application(handle));
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RuntimeState::default())
        .manage(StatusState::default())
        .setup(|app| {
            build_tray(app)?;
            // The first tick finds no Companion and starts the bundled runtime.
            start_status_loop(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle();
                if !runtime_state(app).quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            WindowEvent::Focused(true) => wake_status_loop(window.app_handle()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_status,
            get_local_mcp_command,
            save_runtime_api_key,
            forget_runtime_api_key,
            perform_action,
            configure_extension,
            add_workspace,
            rename_workspace,
            get_workspace_paths,
            reveal_workspace,
            remove_workspace,
            get_diagnostics,
            handoff_request,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("Kairomes Desktop failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection_json(origin: &str, token: &str, pid: u32, instance: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "instanceId": instance,
            "pid": pid,
            "origin": origin,
            "token": token,
        }))
        .unwrap()
    }

    fn snapshot(companion: Option<Value>) -> DesktopSnapshot {
        DesktopSnapshot {
            version: "0.2.0",
            sequence: 1,
            credential_configured: true,
            tunnel_client_installed: true,
            runtime: desktop_runtime(companion.is_some(), true, None),
            companion,
            version_mismatch: false,
        }
    }

    fn companion(tunnel: &str, connector: &str, pending: Option<u64>) -> Value {
        json!({
            "version": "0.2.0",
            "versionMismatch": false,
            "workspaces": [{ "id": "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4", "name": "A" }],
            "workbench": { "state": "running" },
            "tunnel": { "state": tunnel, "nextRetryAt": null },
            "connector": { "state": connector },
            "attention": {
                "pending": pending.map(|total| json!({ "total": total, "byWorkspace": [] })),
            },
        })
    }

    #[test]
    fn windows_path_with_spaces_uses_forward_slashes_for_tunnel_client() {
        let command =
            format_local_mcp_command(r"C:\Program Files\Kairomes\kairomes-runtime.exe", true)
                .unwrap();
        assert_eq!(
            command,
            r#""C:/Program Files/Kairomes/kairomes-runtime.exe" relay --stdio"#
        );
    }

    #[test]
    fn rejects_quotes_that_would_break_the_command() {
        assert!(
            format_local_mcp_command(r#"C:\Kairomes"test\kairomes-runtime.exe"#, true).is_err()
        );
    }

    #[test]
    fn passes_the_pairing_lifetime_through_only_when_bounded() {
        let result = pairing_result(&json!({ "pairingUrl": "u", "expiresInSeconds": 120 }));
        assert_eq!(result.pairing_url.as_deref(), Some("u"));
        assert_eq!(result.expires_in_seconds, Some(120));
        for invalid in [json!(0), json!(-1), json!(3601), json!("120"), json!(1.5)] {
            let result = pairing_result(&json!({ "pairingUrl": "u", "expiresInSeconds": invalid }));
            assert_eq!(result.expires_in_seconds, None);
        }
        assert_eq!(pairing_result(&json!({})).pairing_url, None);
    }

    #[test]
    fn external_links_are_a_fixed_allowlist() {
        for (target, url) in [
            (
                "runtime_keys",
                "https://platform.openai.com/settings/organization/api-keys",
            ),
            (
                "chatgpt_connectors",
                "https://chatgpt.com/#settings/Connectors",
            ),
            (
                "tunnel_guide",
                "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
            ),
            (
                "tunnel_releases",
                "https://github.com/openai/tunnel-client/releases/latest",
            ),
            (
                "platform_tunnels",
                "https://platform.openai.com/settings/organization/tunnels",
            ),
            (
                "kairomes_releases",
                "https://github.com/tennosuke5245/Kairomes/releases",
            ),
        ] {
            assert_eq!(external_url(target), Some(url));
        }
        for rejected in [
            "",
            "TUNNEL_GUIDE",
            " tunnel_guide",
            "tunnel_guide ",
            "https://example.com",
            "file:///C:/Windows",
            "javascript:alert(1)",
            "open_workbench",
        ] {
            assert_eq!(external_url(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn webview_actions_cannot_reach_quit_or_management_routes() {
        for allowed in COMPANION_ACTIONS {
            assert_eq!(companion_action(allowed), Some(allowed));
        }
        for rejected in [
            "quit",
            "configure_extension",
            "workspace_add",
            "workspace_remove",
            "workspace_rename",
            "workspace_details",
            "diagnostics",
            "restart_runtime",
            "OPEN_WORKBENCH",
            "open_workbench ",
            "",
        ] {
            assert_eq!(companion_action(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn connection_descriptor_accepts_only_a_loopback_origin_and_hex_token() {
        let token = "a".repeat(64);
        assert!(
            parse_connection(&connection_json("http://127.0.0.1:4100", &token, 7, "i")).is_ok()
        );
        for origin in [
            "https://127.0.0.1:4100",
            "http://localhost:4100",
            "http://127.0.0.2:4100",
            "http://127.0.0.1",
            "http://127.0.0.1:4100/",
            "http://127.0.0.1:4100/api",
            "http://127.0.0.1:4100?x=1",
            "http://127.0.0.1:4100#x",
            "http://user@127.0.0.1:4100",
            "http://user:pass@127.0.0.1:4100",
            "http://evil.example",
            "not a url",
        ] {
            assert!(
                parse_connection(&connection_json(origin, &token, 7, "i")).is_err(),
                "{origin}"
            );
        }
        for bad_token in [
            "A".repeat(64),
            "a".repeat(63),
            "a".repeat(65),
            format!("{}g", "a".repeat(63)),
            String::new(),
        ] {
            assert!(parse_connection(&connection_json(
                "http://127.0.0.1:4100",
                &bad_token,
                7,
                "i"
            ))
            .is_err());
        }
        assert!(
            parse_connection(&connection_json("http://127.0.0.1:4100", &token, 0, "i")).is_err()
        );
        assert!(
            parse_connection(&connection_json("http://127.0.0.1:4100", &token, 7, "")).is_err()
        );
        assert!(parse_connection(b"{").is_err());
        assert!(parse_connection(b"[]").is_err());
    }

    #[test]
    fn uuid_check_is_strict() {
        assert!(is_uuid("2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4"));
        for rejected in [
            "",
            "2ff7f6d9a7ee46e6b4c42e21602056e4",
            "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e",
            "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4 ",
            "../../../../etc/passwd/aaaaaaaaaaaaaaaa",
            "2ff7f6d9-a7ee-46e6-b4c4_2e21602056e4",
            "2ff7f6d9-a7ee-46e6-b4c4-2e21602056eg",
        ] {
            assert!(!is_uuid(rejected), "{rejected}");
        }
    }

    #[test]
    fn workspace_paths_keep_only_ids_and_roots() {
        let paths = parse_workspace_paths(&json!({
            "workspaces": [
                { "id": "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4", "name": "A", "root": "C:\\work\\a" }
            ]
        }))
        .unwrap();
        assert_eq!(
            paths,
            vec![WorkspacePath {
                id: "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4".to_string(),
                root: "C:\\work\\a".to_string(),
            }]
        );
        let serialized = serde_json::to_value(&paths).unwrap();
        assert_eq!(serialized[0].as_object().unwrap().len(), 2);
        for invalid in [
            json!({}),
            json!({ "workspaces": {} }),
            json!({ "workspaces": [{ "id": "x", "root": "/a" }] }),
            json!({ "workspaces": [{ "id": "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4", "root": "" }] }),
            json!({ "workspaces": [{ "id": "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4" }] }),
        ] {
            assert!(parse_workspace_paths(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn reveal_accepts_only_an_existing_absolute_directory() {
        let base = std::env::temp_dir().join(format!(
            "kairomes-reveal-{}-{}",
            std::process::id(),
            DESKTOP_VERSION
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("project")).unwrap();
        fs::write(base.join("file.txt"), b"x").unwrap();
        let project = base.join("project");
        assert_eq!(revealable_root(project.to_str().unwrap()).unwrap(), project);
        assert!(revealable_root("project").is_err());
        assert!(revealable_root("").is_err());
        assert!(revealable_root(base.join("missing").to_str().unwrap()).is_err());
        assert!(revealable_root(base.join("file.txt").to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            let link = base.join("link");
            std::os::unix::fs::symlink(&project, &link).unwrap();
            assert!(revealable_root(link.to_str().unwrap()).is_err());
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn tray_tooltip_reflects_state_without_details() {
        assert_eq!(tray_status(&snapshot(None)), TrayStatus::Starting);
        let mut failed = snapshot(None);
        failed.runtime = desktop_runtime(false, true, Some("Kairomes 本機服務已停止。".into()));
        assert_eq!(tray_status(&failed), TrayStatus::Problem);

        let ready = snapshot(Some(companion("running", "connected", Some(0))));
        assert_eq!(tray_status(&ready), TrayStatus::Ready);
        assert_eq!(
            tray_status(&snapshot(Some(companion("running", "waiting", None)))),
            TrayStatus::Waiting
        );
        assert_eq!(
            tray_status(&snapshot(Some(companion("starting", "blocked", None)))),
            TrayStatus::Connecting
        );
        assert_eq!(
            tray_status(&snapshot(Some(companion("stopped", "blocked", None)))),
            TrayStatus::Paused
        );
        assert_eq!(
            tray_status(&snapshot(Some(companion("error", "blocked", None)))),
            TrayStatus::Problem
        );
        let mut retrying = companion("error", "blocked", None);
        retrying["tunnel"]["nextRetryAt"] = json!("2026-10-06T12:00:10.000Z");
        assert_eq!(
            tray_status(&snapshot(Some(retrying))),
            TrayStatus::Connecting
        );

        // Pending approvals outrank a failing Tunnel.
        let pending = snapshot(Some(companion("error", "blocked", Some(2))));
        assert_eq!(tray_status(&pending), TrayStatus::Pending(2));

        let mut setup = snapshot(Some(companion("stopped", "blocked", Some(0))));
        setup.credential_configured = false;
        assert_eq!(tray_status(&setup), TrayStatus::Setup);
        let mut empty = companion("running", "waiting", Some(0));
        empty["workspaces"] = json!([]);
        assert_eq!(tray_status(&snapshot(Some(empty))), TrayStatus::Setup);
        let mut mismatch = snapshot(Some(companion("running", "connected", Some(0))));
        mismatch.version_mismatch = true;
        assert_eq!(tray_status(&mismatch), TrayStatus::Problem);
        let mut no_client = snapshot(Some(companion("running", "connected", Some(0))));
        no_client.tunnel_client_installed = false;
        assert_eq!(tray_status(&no_client), TrayStatus::Problem);
        let mut workbench_down = companion("running", "connected", Some(0));
        workbench_down["workbench"]["state"] = json!("error");
        assert_eq!(
            tray_status(&snapshot(Some(workbench_down))),
            TrayStatus::Problem
        );
        let mut workbench_external = companion("running", "connected", Some(0));
        workbench_external["workbench"]["state"] = json!("external");
        assert_eq!(
            tray_status(&snapshot(Some(workbench_external))),
            TrayStatus::Ready
        );

        assert_eq!(tray_tooltip(TrayStatus::Pending(2)), "Kairomes · 需確認 2");
        assert_eq!(
            tray_tooltip(TrayStatus::Pending(240)),
            "Kairomes · 需確認 99+"
        );
        assert_eq!(tray_tooltip(TrayStatus::Ready), "Kairomes · 已就緒");
        assert_eq!(tray_tooltip(TrayStatus::Problem), "Kairomes · 需要處理");
        for status in [
            TrayStatus::Starting,
            TrayStatus::Setup,
            TrayStatus::Problem,
            TrayStatus::Pending(1),
            TrayStatus::Paused,
            TrayStatus::Connecting,
            TrayStatus::Waiting,
            TrayStatus::Ready,
        ] {
            let tooltip = tray_tooltip(status);
            assert!(tooltip.starts_with("Kairomes · "));
            assert!(!tooltip.contains('/') && !tooltip.contains('\\') && !tooltip.contains(':'));
            assert!(tooltip.chars().count() <= 32);
        }
    }

    #[test]
    fn attention_is_requested_only_when_pending_appears_unattended() {
        assert!(should_request_attention(0, Some(2), false));
        assert!(!should_request_attention(0, Some(2), true));
        assert!(!should_request_attention(1, Some(2), false));
        assert!(!should_request_attention(0, Some(0), false));
        assert!(!should_request_attention(0, None, false));
        assert_eq!(status_interval(true), Duration::from_secs(2));
        assert_eq!(status_interval(false), Duration::from_secs(6));
    }

    #[test]
    fn pending_and_workbench_readiness_come_from_the_companion_snapshot() {
        assert_eq!(pending_total(&snapshot(None)), None);
        assert_eq!(
            pending_total(&snapshot(Some(companion("running", "connected", Some(3))))),
            Some(3)
        );
        assert_eq!(
            pending_total(&snapshot(Some(companion("running", "connected", None)))),
            None
        );
        assert!(!workbench_ready(&snapshot(None)));
        assert!(workbench_ready(&snapshot(Some(companion(
            "running",
            "connected",
            None
        )))));
    }

    #[test]
    fn version_mismatch_covers_desktop_companion_and_workbench() {
        assert!(!version_mismatch(
            "0.2.0",
            &json!({ "version": "0.2.0", "versionMismatch": false })
        ));
        assert!(version_mismatch("0.2.0", &json!({ "version": "0.1.4" })));
        assert!(version_mismatch("0.2.0", &json!({})));
        assert!(version_mismatch(
            "0.2.0",
            &json!({ "version": "0.2.0", "versionMismatch": true })
        ));
    }

    #[test]
    fn runtime_state_prefers_a_live_companion_over_a_stale_error() {
        assert_eq!(
            desktop_runtime(true, false, Some("x".into())).state,
            "running"
        );
        assert_eq!(
            desktop_runtime(false, true, Some("x".into())).state,
            "error"
        );
        assert_eq!(desktop_runtime(false, true, None).state, "starting");
    }

    #[test]
    fn runtime_errors_are_capped_on_a_character_boundary() {
        assert_eq!(truncate_message("短訊息".to_string(), 320), "短訊息");
        // 107 three-byte characters are 321 bytes; the cap must not split the last one.
        let long = "服".repeat(107);
        let capped = truncate_message(long, 320);
        assert_eq!(capped.len(), 318);
        assert_eq!(capped.chars().count(), 106);
        assert_eq!(truncate_message("a".repeat(400), 320).len(), 320);
    }

    #[test]
    fn cached_values_expire_after_their_ttl() {
        let now = Instant::now();
        let ttl = Duration::from_secs(30);
        assert_eq!(cached(Some((true, now)), now, ttl), Some(true));
        assert_eq!(
            cached(Some((false, now)), now + Duration::from_secs(29), ttl),
            Some(false)
        );
        assert_eq!(cached(Some((true, now)), now + ttl, ttl), None);
        assert_eq!(cached::<bool>(None, now, ttl), None);
    }

    #[test]
    fn snapshot_serializes_with_the_ui_field_names() {
        let value = serde_json::to_value(snapshot(None)).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "companion",
                "credentialConfigured",
                "runtime",
                "sequence",
                "tunnelClientInstalled",
                "version",
                "versionMismatch"
            ]
        );
    }
}
