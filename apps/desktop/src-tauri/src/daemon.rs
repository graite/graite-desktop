//! Spawns and supervises the Python daemon sidecar (ARCHITECTURE.md §9).
//!
//! Dev: if `GRAITE_DAEMON_URL` and `GRAITE_DAEMON_TOKEN` are set, no process is spawned and
//! the UI talks to an externally started `graite-daemon --dev` (see `just dev`).
//! Release: `resources/daemon/graite-daemon` (PyInstaller onedir) is started with a random
//! token; its first stdout line is `{"port": N, ...}`. Its stdin is kept open so the daemon
//! exits when this process dies.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
pub struct DaemonInfo {
    pub url: String,
    pub token: String,
    /// The vault folder the daemon serves; `None` when an external dev daemon owns it.
    pub vault: Option<String>,
    /// True under `just dev`: the shell did not spawn the daemon and cannot switch vaults.
    pub dev: bool,
}

/// Error the webview receives while no vault has been chosen yet.
pub const NO_VAULT: &str = "no-vault";

#[derive(Deserialize)]
struct Handshake {
    port: u16,
}

pub struct DaemonState {
    pub info: DaemonInfo,
    vault: Option<PathBuf>,
    child: Mutex<Option<Child>>,
}

// Start the service off the UI thread, so the logo can render during its handshake.
#[derive(Clone, Default)]
pub struct DaemonStartup(Arc<(Mutex<StartupState>, Condvar)>);

#[derive(Default)]
struct StartupState {
    result: Option<Result<DaemonState, String>>,
    exiting: bool,
    /// A launch is underway or done. Unarmed means "no vault chosen": callers get an
    /// immediate `no-vault` error instead of waiting for a daemon that will never start.
    armed: bool,
}

impl DaemonStartup {
    pub fn launch(&self, app: AppHandle, vault: PathBuf) {
        {
            let (lock, _) = &*self.0;
            lock.lock().unwrap().armed = true;
        }
        let startup = self.clone();
        std::thread::spawn(move || startup.finish(start(&app, &vault)));
    }

    /// Record a launch failure without spawning anything (an invalid `GRAITE_VAULT`).
    pub fn fail(&self, error: String) {
        {
            let (lock, _) = &*self.0;
            lock.lock().unwrap().armed = true;
        }
        self.finish(Err(error));
    }

    /// Stop the running daemon (if any) and start one on `vault`. Blocks until the new
    /// handshake arrives; other `wait_info` callers wait with it.
    pub fn switch(&self, app: &AppHandle, vault: PathBuf) -> Result<DaemonInfo, String> {
        let previous = {
            let (lock, _) = &*self.0;
            let mut state = lock.lock().unwrap();
            if state.exiting {
                return Err("Graite is closing.".into());
            }
            if let Some(Ok(daemon)) = &state.result {
                if daemon.info.dev {
                    return Err("The vault is managed by the dev daemon (just dev).".into());
                }
                if daemon.vault.as_deref() == Some(vault.as_path()) {
                    return Ok(daemon.info.clone());
                }
            }
            state.armed = true;
            state.result.take()
        };
        if let Some(Ok(daemon)) = previous {
            daemon.shutdown(); // two daemons must never share one .graite/index.sqlite
        }
        self.finish(start(app, &vault));
        self.wait_info()
    }

    fn finish(&self, result: Result<DaemonState, String>) {
        let (lock, ready) = &*self.0;
        let mut state = lock.lock().unwrap();
        if state.exiting {
            drop(state);
            if let Ok(daemon) = result {
                daemon.shutdown();
            }
            return;
        }
        state.result = Some(result);
        ready.notify_all();
    }

    pub fn wait_info(&self) -> Result<DaemonInfo, String> {
        let (lock, ready) = &*self.0;
        let state = ready
            .wait_while(lock.lock().unwrap(), |s| {
                s.result.is_none() && !s.exiting && s.armed
            })
            .unwrap();
        if !state.armed && state.result.is_none() && !state.exiting {
            return Err(NO_VAULT.into());
        }
        match &state.result {
            Some(Ok(daemon)) => Ok(daemon.info.clone()),
            Some(Err(error)) => Err(error.clone()),
            None => Err("Graite is closing.".into()),
        }
    }

    pub fn shutdown(&self) {
        let (lock, ready) = &*self.0;
        let mut state = lock.lock().unwrap();
        state.exiting = true;
        let result = state.result.take();
        ready.notify_all();
        drop(state);
        if let Some(Ok(daemon)) = result {
            daemon.shutdown();
        }
    }
}

impl DaemonState {
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                // Closing stdin tells the daemon to exit; kill is the fallback.
                drop(child.stdin.take());
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = child.kill();
            }
        }
    }
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "graite-daemon.exe"
    } else {
        "graite-daemon"
    };
    app.path()
        .resolve(
            format!("resources/daemon/{name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())
}

/// The daemon bundled next to an installed app binary, found without a running app:
/// `<prefix>/bin/<app>` ships its resources in `<prefix>/lib/<name>/resources/` (the layout of
/// the AppImage and the Linux packages). Used by `<app> mcp`, which runs before Tauri starts.
#[cfg(target_os = "linux")]
pub fn bundled_sidecar(exe: &Path) -> Option<PathBuf> {
    let lib = exe.parent()?.parent()?.join("lib");
    let mut found: Vec<PathBuf> = std::fs::read_dir(lib)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join("resources/daemon/graite-daemon"))
        .filter(|candidate| candidate.is_file())
        .collect();
    found.sort();
    found.into_iter().next()
}

#[cfg(all(test, target_os = "linux"))]
mod bundled_sidecar_tests {
    use super::bundled_sidecar;

    #[test]
    fn finds_the_daemon_beside_an_installed_binary_and_nothing_elsewhere() {
        let root = std::env::temp_dir().join(format!("graite-sidecar-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = root.join("usr/bin/graite-desktop");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(bundled_sidecar(&exe), None); // no lib folder at all

        // Other software shares <prefix>/lib; only a folder that holds our daemon counts.
        std::fs::create_dir_all(root.join("usr/lib/x86_64-linux-gnu")).unwrap();
        assert_eq!(bundled_sidecar(&exe), None);
        let daemon = root.join("usr/lib/Graite/resources/daemon/graite-daemon");
        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, b"").unwrap();
        assert_eq!(bundled_sidecar(&exe), Some(daemon));

        // A dev build in target/debug has no such layout.
        assert_eq!(bundled_sidecar(&root.join("graite-desktop")), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// True under `just dev`: an external `graite-daemon --dev` owns the vault.
pub fn dev_mode() -> bool {
    std::env::var_os("GRAITE_DAEMON_URL").is_some()
        && std::env::var_os("GRAITE_DAEMON_TOKEN").is_some()
}

/// The vault to open at launch: the launcher's `GRAITE_VAULT`, else the remembered one,
/// else nothing (the webview shows the picker).
pub fn initial_vault(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    // A local launcher can reuse an existing vault without moving any notes or settings.
    if let Some(value) = std::env::var_os("GRAITE_VAULT") {
        let dir = PathBuf::from(value);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err("GRAITE_VAULT must point to an existing absolute vault folder".into());
        }
        let _ = crate::vaults::remember(app, &dir);
        return Ok(Some(dir));
    }
    Ok(crate::vaults::load(app).current.filter(|dir| dir.is_dir()))
}

pub fn start(app: &AppHandle, vault: &Path) -> Result<DaemonState, String> {
    if let (Ok(url), Ok(token)) = (
        std::env::var("GRAITE_DAEMON_URL"),
        std::env::var("GRAITE_DAEMON_TOKEN"),
    ) {
        return Ok(DaemonState {
            info: DaemonInfo {
                url,
                token,
                vault: None,
                dev: true,
            },
            vault: None,
            child: Mutex::new(None),
        });
    }

    let exe = sidecar_path(app)?;
    if !exe.exists() {
        return Err(format!(
            "daemon sidecar not found at {} (run `just sidecar`, or set GRAITE_DAEMON_URL/TOKEN for dev)",
            exe.display()
        ));
    }
    if !vault.is_absolute() {
        return Err("The vault must be an absolute folder path.".into());
    }
    let token = random_token();

    let mut command = Command::new(&exe);
    // The sidecar is a console program; on Windows it would open a console window of its own.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .arg("--vault")
        .arg(vault)
        .arg("--port")
        .arg("0")
        .arg("--token")
        .arg(&token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to start daemon: {e}"))?;

    let stdout = child.stdout.take().ok_or("daemon stdout not captured")?;
    let mut first_line = String::new();
    BufReader::new(stdout)
        .read_line(&mut first_line)
        .map_err(|e| format!("daemon handshake read failed: {e}"))?;
    // The daemon announces its port only once it is up. No line means it could not start; its
    // own log says why (a desktop launcher throws the daemon's stderr away).
    if first_line.trim().is_empty() {
        let _ = child.wait();
        return Err(startup_failure_message());
    }
    let handshake: Handshake = serde_json::from_str(first_line.trim())
        .map_err(|e| format!("bad daemon handshake {first_line:?}: {e}"))?;

    // Keep stdin open (the daemon watches it for EOF); flush a no-op write to verify the pipe.
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.flush();
    }

    Ok(DaemonState {
        info: DaemonInfo {
            url: format!("http://127.0.0.1:{}", handshake.port),
            token,
            vault: Some(vault.display().to_string()),
            dev: false,
        },
        vault: Some(vault.to_path_buf()),
        child: Mutex::new(Some(child)),
    })
}

/// What the startup screen shows when the daemon exits before announcing itself.
fn startup_failure_message() -> String {
    let log = std::env::var_os("GRAITE_APP_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".graite"))
        })
        .map(|dir| dir.join("logs").join("daemon.log").display().to_string())
        .unwrap_or_else(|| "logs/daemon.log in Graite's folder".into());
    format!("Graite's service could not start. The reason is in {log}")
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    fn armed() -> DaemonStartup {
        let startup = DaemonStartup::default();
        startup.0 .0.lock().unwrap().armed = true;
        startup
    }

    fn fake(url: &str) -> DaemonState {
        DaemonState {
            info: DaemonInfo {
                url: url.into(),
                token: "test".into(),
                vault: Some("/v".into()),
                dev: false,
            },
            vault: Some(PathBuf::from("/v")),
            child: Mutex::new(None),
        }
    }

    #[test]
    fn waiters_receive_ready_service_info() {
        let startup = armed();
        let waiter = startup.clone();
        let thread = std::thread::spawn(move || waiter.wait_info());
        startup.finish(Ok(fake("http://127.0.0.1:1234")));
        let info = thread.join().unwrap().unwrap();
        assert_eq!(info.url, "http://127.0.0.1:1234");
        assert_eq!(info.vault.as_deref(), Some("/v"));
        startup.shutdown();
    }

    #[test]
    fn failed_startup_is_reported_and_shutdown_releases_waiters() {
        let startup = armed();
        startup.finish(Err("Service unavailable".into()));
        assert_eq!(startup.wait_info().err().unwrap(), "Service unavailable");
        let pending = armed();
        let waiter = pending.clone();
        let thread = std::thread::spawn(move || waiter.wait_info());
        pending.shutdown();
        assert_eq!(thread.join().unwrap().err().unwrap(), "Graite is closing.");
    }

    #[test]
    fn unarmed_startup_reports_no_vault_without_blocking() {
        let startup = DaemonStartup::default();
        assert_eq!(startup.wait_info().err().unwrap(), NO_VAULT);
        // Arming later (a vault was picked) makes the same handle wait for the handshake.
        startup.0 .0.lock().unwrap().armed = true;
        startup.finish(Ok(fake("http://127.0.0.1:9")));
        assert_eq!(startup.wait_info().unwrap().url, "http://127.0.0.1:9");
        startup.shutdown();
    }
}
