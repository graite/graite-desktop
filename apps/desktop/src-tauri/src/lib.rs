mod daemon;
#[cfg(target_os = "linux")]
pub use daemon::bundled_sidecar;
mod vaults;

/// Shown instead of reloading once the web view has crashed three times within a minute.
#[cfg(target_os = "linux")]
const CRASH_PAGE: &str = "<!doctype html><meta charset=utf-8><body style=\"font:14px system-ui;padding:40px;max-width:520px\"><h3>Graite's window stopped working</h3><p>The display part of Graite crashed several times in a row. This often comes from the microphone or audio device. Check your sound settings, then quit and reopen Graite. Your pages are safe.</p></body>";

/// Whether the web view crashed often enough recently that reloading would only loop.
#[cfg(target_os = "linux")]
fn renderer_crash_loop() -> bool {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CRASHES: OnceLock<Mutex<Vec<Instant>>> = OnceLock::new();
    let mut crashes = CRASHES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    crashes.retain(|at| now.duration_since(*at) < Duration::from_secs(60));
    crashes.push(now);
    crashes.len() >= 3
}

fn is_local_media_url(uri: &str) -> bool {
    let Ok(url) = tauri::Url::parse(uri) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None)
            | ("http", Some("tauri.localhost"), None)
            | ("http", Some("localhost"), Some(1420))
    )
}

#[cfg(test)]
mod media_permission_tests {
    use super::is_local_media_url;
    #[test]
    fn accepts_app_root_and_paths_but_rejects_other_origins() {
        for uri in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://localhost:1420/",
        ] {
            assert!(is_local_media_url(uri), "{uri}");
        }
        for uri in [
            "https://example.com",
            "tauri://localhost.evil/",
            "http://localhost:1423/",
            "tauri://user@localhost/",
            "tauri://localhost:9999/",
        ] {
            assert!(!is_local_media_url(uri), "{uri}");
        }
    }
}

static MICROPHONE_REQUEST: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn prepare_microphone() {
    MICROPHONE_REQUEST.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn reveal_folder(path: String) -> Result<(), String> {
    let folder = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !folder.is_dir() {
        return Err("This folder no longer exists.".into());
    }
    #[cfg(target_os = "linux")]
    let command = "xdg-open";
    #[cfg(target_os = "macos")]
    let command = "open";
    #[cfg(target_os = "windows")]
    let command = "explorer";
    std::process::Command::new(command)
        .arg(folder)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// File types the default app may open: documents and media only, never anything runnable.
const OPENABLE: [&str; 18] = [
    "png", "jpg", "jpeg", "webp", "tif", "tiff", "pdf", "md", "txt", "wav", "mp3", "m4a", "mp4",
    "webm", "ogg", "oga", "flac", "aac",
];

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let file = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !file.is_file() {
        return Err("This file no longer exists.".into());
    }
    // Only page attachments: the parent folder must be a page's `_assets`.
    let in_assets = file
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == "_assets");
    let extension = file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !in_assets || !extension.is_some_and(|e| OPENABLE.contains(&e.as_str())) {
        return Err(
            "This file type cannot be opened from Graite. Show it in its folder instead.".into(),
        );
    }
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash for `start`
        c
    };
    command.arg(file).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

use tauri::{Emitter, Manager, RunEvent};

#[tauri::command]
async fn get_daemon_info(
    state: tauri::State<'_, daemon::DaemonStartup>,
) -> Result<daemon::DaemonInfo, String> {
    let startup = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || startup.wait_info())
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct VaultList {
    current: Option<String>,
    recent: Vec<String>,
    /// Under `just dev` the daemon owns the vault and the shell cannot switch it.
    dev: bool,
}

fn vault_list(vaults: vaults::Vaults) -> VaultList {
    VaultList {
        current: vaults.current.map(|p| p.display().to_string()),
        recent: vaults
            .recent
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        dev: daemon::dev_mode(),
    }
}

#[tauri::command]
fn list_vaults(app: tauri::AppHandle) -> VaultList {
    vault_list(vaults::load(&app))
}

#[tauri::command]
fn inspect_vault(path: String) -> vaults::VaultProbe {
    vaults::inspect(std::path::Path::new(&path))
}

#[tauri::command]
fn forget_vault(app: tauri::AppHandle, path: String) -> Result<VaultList, String> {
    vaults::forget(&app, std::path::Path::new(&path)).map(vault_list)
}

/// Open `path` as the vault: stop the current daemon, start one there, remember the choice.
/// `create` allows a folder that does not exist yet; a typo never creates one otherwise.
#[tauri::command]
async fn open_vault(
    app: tauri::AppHandle,
    state: tauri::State<'_, daemon::DaemonStartup>,
    path: String,
    create: bool,
) -> Result<daemon::DaemonInfo, String> {
    if daemon::dev_mode() {
        return Err("The vault is managed by the dev daemon (just dev).".into());
    }
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_absolute() {
        return Err("Choose an absolute folder path.".into());
    }
    if !dir.is_dir() {
        if !create {
            return Err("This folder does not exist.".into());
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the folder: {e}"))?;
    }
    let startup = state.inner().clone();
    let handle = app.clone();
    let target = dir.clone();
    let info = tauri::async_runtime::spawn_blocking(move || startup.switch(&handle, target))
        .await
        .map_err(|e| e.to_string())??;
    vaults::remember(&app, &dir)?;
    let _ = app.emit("vault-changed", &info);
    Ok(info)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let startup = daemon::DaemonStartup::default();
            app.manage(startup.clone());
            let handle = app.handle().clone();
            if daemon::dev_mode() {
                startup.launch(handle, std::path::PathBuf::new());
            } else {
                match daemon::initial_vault(&handle) {
                    Ok(Some(vault)) => startup.launch(handle, vault),
                    Ok(None) => {} // first run: the webview shows the vault picker
                    Err(error) => startup.fail(error),
                }
            }
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webkit2gtk::{
                        glib::Cast, PermissionRequestExt, SettingsExt,
                        UserMediaPermissionRequestExt, WebViewExt,
                    };
                    if let Some(settings) = webview.inner().settings() {
                        settings.set_enable_media_stream(true);
                        settings.set_enable_webrtc(true);
                    }
                    // The web process can die under us (seen when the capture device fails in
                    // WebKitGTK's GStreamer pipeline). Left alone the window stays flat gray;
                    // reload it instead, unless it keeps crashing.
                    webview
                        .inner()
                        .connect_web_process_terminated(|view, reason| {
                            eprintln!("graite: the web view process ended ({reason:?})");
                            if renderer_crash_loop() {
                                view.load_html(CRASH_PAGE, None);
                            } else {
                                view.reload();
                            }
                        });
                    webview.inner().connect_permission_request(|view, request| {
                        if let Some(media) =
                            request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>()
                        {
                            let local = view
                                .uri()
                                .map(|uri| is_local_media_url(uri.as_str()))
                                .unwrap_or(false);
                            if local
                                && media.is_for_audio_device()
                                && !media.is_for_video_device()
                                && MICROPHONE_REQUEST
                                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                            {
                                request.allow();
                            } else {
                                request.deny();
                            }
                            return true;
                        }
                        false
                    });
                })?;
            }
            // Debug builds: open the WebKit inspector when GRAITE_DEVTOOLS=1 so console errors are visible.
            #[cfg(debug_assertions)]
            if std::env::var_os("GRAITE_DEVTOOLS").is_some() {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_daemon_info,
            prepare_microphone,
            reveal_folder,
            open_path,
            list_vaults,
            inspect_vault,
            open_vault,
            forget_vault
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<daemon::DaemonStartup>() {
                    state.shutdown();
                }
            }
        });
}
