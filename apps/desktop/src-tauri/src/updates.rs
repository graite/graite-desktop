//! The app updating itself from the newest published GitHub release (`tauri-plugin-updater`).
//!
//! Only installs that nothing else keeps up to date do this: the macOS app and the Linux
//! AppImage. The Microsoft Store updates its own package, a `.deb` belongs to the system's
//! package manager, and a dev run has nothing to replace. Nothing is installed until the user
//! asks for it.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// How often a progress event goes to the window while downloading.
const PROGRESS_STEP: u64 = 512 * 1024;

#[derive(Serialize)]
pub struct UpdateStatus {
    version: String,
    supported: bool,
}

#[derive(Serialize)]
pub struct AppUpdate {
    version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Whether this kind of install replaces itself. `appimage`: running from an AppImage.
fn self_updating(appimage: bool) -> bool {
    cfg!(target_os = "macos") || (cfg!(target_os = "linux") && appimage)
}

fn supported() -> bool {
    !cfg!(debug_assertions)
        && !crate::daemon::dev_mode()
        && self_updating(std::env::var_os("APPIMAGE").is_some())
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    UpdateStatus {
        version: app.package_info().version.to_string(),
        supported: supported(),
    }
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<AppUpdate>, String> {
    if !supported() {
        return Ok(None);
    }
    let update = app.updater().map_err(text)?.check().await.map_err(text)?;
    Ok(update.map(|update| AppUpdate {
        version: update.version.clone(),
        notes: update.body.clone(),
    }))
}

/// Download the newest version, put it in place and restart. Returns only when that failed.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if !supported() {
        return Err("This copy of Graite is updated by the place it was installed from.".into());
    }
    let update = app
        .updater()
        .map_err(text)?
        .check()
        .await
        .map_err(text)?
        .ok_or_else(|| "There is no update to install.".to_string())?;
    let window = app.clone();
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - reported >= PROGRESS_STEP || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = window.emit("update-progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(text)?;
    // The new version starts its own daemon: stop ours first, so the two never share a vault.
    if let Some(state) = app.try_state::<crate::daemon::DaemonStartup>() {
        state.shutdown();
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::self_updating;

    #[test]
    fn only_the_mac_app_and_the_appimage_replace_themselves() {
        assert_eq!(self_updating(true), cfg!(any(target_os = "macos", target_os = "linux")));
        assert_eq!(self_updating(false), cfg!(target_os = "macos"));
    }
}
