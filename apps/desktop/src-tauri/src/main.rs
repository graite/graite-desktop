// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// `<app> mcp`: become the daemon's stdio bridge for MCP clients (Claude Desktop, Claude Code,
/// Cursor). This gives an AppImage a command that survives restarts: the sidecar inside it is
/// mounted at a new `/tmp/.mount_…` path on every start, but the AppImage file stays put.
/// Runs before anything graphical is touched; `exec` hands over stdio and signals as they are.
#[cfg(target_os = "linux")]
fn run_mcp_bridge() -> ! {
    use std::os::unix::process::CommandExt;
    let sidecar = std::env::current_exe()
        .ok()
        .and_then(|exe| graite_desktop_lib::bundled_sidecar(&exe));
    let Some(sidecar) = sidecar else {
        eprintln!("graite: the bundled daemon was not found next to this app.");
        std::process::exit(1);
    };
    let error = std::process::Command::new(&sidecar)
        .args(std::env::args_os().skip(1))
        .exec();
    eprintln!("graite: could not start {}: {error}", sidecar.display());
    std::process::exit(1);
}

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        run_mcp_bridge();
    }
    // WebKitGTK's DMA-BUF renderer fails on some Linux GPU/driver combinations (seen on
    // NVIDIA GB10: "Failed to create GBM buffer ... Permission denied") and the window
    // paints flat gray. The fallback renderer is fine for us. Respect an explicit override.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    graite_desktop_lib::run()
}
