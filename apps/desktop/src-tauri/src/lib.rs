use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const KEYRING_SERVICE: &str = "dev.tennosuke.kairomes";
const KEYRING_ACCOUNT: &str = "control-plane-api-key";
const CONNECTION_FILE: &str = "companion-connection.json";
const CHATGPT_CONNECTORS_URL: &str = "https://chatgpt.com/#settings/Connectors";
const RUNTIME_KEYS_URL: &str = "https://platform.openai.com/settings/organization/api-keys";

struct OwnedRuntime {
    generation: u64,
    child: CommandChild,
}

struct RuntimeState {
    process: Mutex<Option<OwnedRuntime>>,
    last_error: Mutex<Option<String>>,
    quitting: AtomicBool,
    generation: AtomicU64,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            last_error: Mutex::new(None),
            quitting: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }
}

#[derive(Debug, Deserialize)]
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
    credential_configured: bool,
    tunnel_client_installed: bool,
    runtime: DesktopRuntime,
    companion: Option<Value>,
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
}

fn runtime_state(app: &AppHandle) -> State<'_, RuntimeState> {
    app.state::<RuntimeState>()
}

fn lock_error() -> String {
    "Kairomes 內部狀態暫時無法存取。".to_string()
}

fn set_runtime_error(app: &AppHandle, message: impl Into<String>) {
    if let Ok(mut slot) = runtime_state(app).last_error.lock() {
        let mut message = message.into();
        if message.len() > 320 {
            message.truncate(320);
        }
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

fn read_connection() -> Result<CompanionConnection, String> {
    let path = data_directory()?.join(CONNECTION_FILE);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Kairomes 本機服務尚未建立連線。".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("Kairomes 本機連線描述檔不安全或已損壞。".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "無法讀取 Kairomes 本機連線描述檔。".to_string())?;
    let connection: CompanionConnection = serde_json::from_slice(&bytes)
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
        && origin.password().is_none();
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

fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| format!("無法建立本機控制連線：{error}"))
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

fn tunnel_client_installed() -> bool {
    which::which("tunnel-client").is_ok()
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

#[cfg(test)]
mod local_mcp_command_tests {
    use super::format_local_mcp_command;

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
}

async fn spawn_runtime(app: &AppHandle) -> Result<(), String> {
    if process_is_owned(app)? || companion_status().await.is_some() {
        return Ok(());
    }

    let api_key = load_runtime_api_key()?;
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
    clear_runtime_error(app);
    // Restart is an explicit takeover action. A normal Desktop quit never stops
    // a Companion that was started by another owner.
    stop_runtime(app, true).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    spawn_runtime(app).await
}

#[tauri::command]
async fn get_desktop_status(app: AppHandle) -> Result<DesktopSnapshot, String> {
    let mut companion = companion_status().await;
    if companion.is_none() && !process_is_owned(&app)? && runtime_error(&app).is_none() {
        if let Err(error) = spawn_runtime(&app).await {
            set_runtime_error(&app, error);
        }
        companion = companion_status().await;
    }

    let owned = process_is_owned(&app)?;
    let runtime = if companion.is_some() {
        DesktopRuntime {
            state: "running",
            owned,
            message: if owned {
                "本機服務由 Kairomes Desktop 管理。".to_string()
            } else {
                "已接上既有的 Kairomes 本機服務。".to_string()
            },
        }
    } else if let Some(error) = runtime_error(&app) {
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
    };

    Ok(DesktopSnapshot {
        credential_configured: load_runtime_api_key()?.is_some(),
        tunnel_client_installed: tunnel_client_installed(),
        runtime,
        companion,
    })
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
    restart_runtime(&app).await
}

#[tauri::command]
async fn forget_runtime_api_key(app: AppHandle) -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(format!("無法從作業系統憑證保管庫移除金鑰：{error}")),
    }
    restart_runtime(&app).await
}

fn pairing_url(value: &Value) -> Option<String> {
    value
        .get("pairingUrl")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

#[tauri::command]
async fn perform_action(app: AppHandle, action: String) -> Result<ActionResult, String> {
    if action == "restart_runtime" {
        restart_runtime(&app).await?;
        return Ok(ActionResult::default());
    }
    let allowed = [
        "open_workbench",
        "open_connectors",
        "retry_workbench",
        "start_tunnel",
        "stop_tunnel",
        "restart_tunnel",
        "create_pairing",
    ];
    if !allowed.contains(&action.as_str()) {
        return Err("不支援的 Kairomes 操作。".to_string());
    }
    let value = companion_request("/api/action", json!({ "action": action })).await?;
    Ok(ActionResult {
        pairing_url: pairing_url(&value),
    })
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
    Ok(ActionResult {
        pairing_url: pairing_url(&response),
    })
}

#[tauri::command]
async fn add_workspace(path: String) -> Result<Value, String> {
    if path.trim().is_empty() || path.len() > 32767 {
        return Err("請選擇有效的專案資料夾。".to_string());
    }
    let response = companion_request(
        "/api/action",
        json!({ "action": "workspace_add", "path": path }),
    )
    .await?;
    response
        .get("workspace")
        .cloned()
        .ok_or_else(|| "Kairomes 沒有回傳新增的專案。".to_string())
}

#[tauri::command]
async fn remove_workspace(workspace_id: String) -> Result<(), String> {
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
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "無法建立接續連線。".to_string())?;
    let response = client
        .post(format!("{}/api/handoff", connection.origin))
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

#[tauri::command]
fn open_external(app: AppHandle, target: String) -> Result<(), String> {
    let url = match target.as_str() {
        "runtime_keys" => RUNTIME_KEYS_URL,
        "chatgpt_connectors" => CHATGPT_CONNECTORS_URL,
        _ => return Err("不支援的外部連結。".to_string()),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("無法開啟瀏覽器：{error}"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

async fn quit_application(app: AppHandle) {
    runtime_state(&app).quitting.store(true, Ordering::SeqCst);
    stop_runtime(&app, false).await;
    app.exit(0);
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "開啟 Kairomes").build(app)?;
    let workbench = MenuItemBuilder::with_id("workbench", "開啟工作台").build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重新啟動本機服務").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "結束 Kairomes").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &workbench, &restart, &separator, &quit])
        .build()?;
    let mut tray = TrayIconBuilder::with_id("kairomes-tray")
        .tooltip("Kairomes")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "workbench" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = companion_request("/api/action", json!({ "action": "open_workbench" }))
                        .await;
                    drop(handle);
                });
            }
            "restart" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = restart_runtime(&handle).await {
                        set_runtime_error(&handle, error);
                    }
                });
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
        .setup(|app| {
            build_tray(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = spawn_runtime(&handle).await {
                    set_runtime_error(&handle, error);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !runtime_state(app).quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_status,
            get_local_mcp_command,
            save_runtime_api_key,
            forget_runtime_api_key,
            perform_action,
            configure_extension,
            add_workspace,
            remove_workspace,
            handoff_request,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("Kairomes Desktop failed to start");
}
