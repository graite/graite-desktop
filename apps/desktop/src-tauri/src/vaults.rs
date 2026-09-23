//! Which vault folder the app opens, and the ones it opened before.
//!
//! Stored as `vaults.json` in the Tauri app-config directory. `GRAITE_VAULT` in the
//! environment (the local launcher) wins over the remembered folder. Nothing here touches
//! the vault itself: whether a folder is a vault is judged from what is already in it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const RECENT_LIMIT: usize = 8;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vaults {
    pub current: Option<PathBuf>,
    #[serde(default)]
    pub recent: Vec<PathBuf>,
}

/// What a folder looks like before it is opened, so the picker can say what will happen.
#[derive(Clone, Debug, Serialize)]
pub struct VaultProbe {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    /// `.graite/` exists: Graite opened this folder before.
    pub has_graite: bool,
    /// Top-level page folders (directories holding a `page.md`).
    pub pages: usize,
    /// Files other than pages, so opening a random folder is a deliberate choice.
    pub other_files: bool,
}

impl Vaults {
    /// Put `path` first in the recent list (deduplicated, capped) and make it current.
    pub fn remember(&mut self, path: &Path) {
        self.recent.retain(|p| p != path);
        self.recent.insert(0, path.to_path_buf());
        self.recent.truncate(RECENT_LIMIT);
        self.current = Some(path.to_path_buf());
    }

    pub fn forget(&mut self, path: &Path) {
        self.recent.retain(|p| p != path);
        if self.current.as_deref() == Some(path) {
            self.current = None;
        }
    }
}

pub fn file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("vaults.json"))
}

pub fn load_from(file: &Path) -> Vaults {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_to(file: &Path, vaults: &Vaults) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(vaults).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle) -> Vaults {
    file(app).map(|f| load_from(&f)).unwrap_or_default()
}

pub fn remember(app: &AppHandle, path: &Path) -> Result<Vaults, String> {
    let file = file(app)?;
    let mut vaults = load_from(&file);
    vaults.remember(path);
    save_to(&file, &vaults)?;
    Ok(vaults)
}

pub fn forget(app: &AppHandle, path: &Path) -> Result<Vaults, String> {
    let file = file(app)?;
    let mut vaults = load_from(&file);
    vaults.forget(path);
    save_to(&file, &vaults)?;
    Ok(vaults)
}

pub fn inspect(path: &Path) -> VaultProbe {
    let mut probe = VaultProbe {
        path: path.display().to_string(),
        exists: path.exists(),
        is_dir: path.is_dir(),
        has_graite: path.join(".graite").is_dir(),
        pages: 0,
        other_files: false,
    };
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue; // .graite, .obsidian, .git: not content
            }
            let child = entry.path();
            if child.is_dir() {
                if child.join("page.md").is_file() {
                    probe.pages += 1;
                } else if !name.starts_with('_') {
                    probe.other_files = true;
                }
            } else if !name.eq_ignore_ascii_case("AGENTS.md") {
                probe.other_files = true;
            }
        }
    }
    probe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_dedupes_caps_and_sets_current() {
        let mut vaults = Vaults::default();
        for i in 0..10 {
            vaults.remember(Path::new(&format!("/v/{i}")));
        }
        vaults.remember(Path::new("/v/3"));
        assert_eq!(vaults.current.as_deref(), Some(Path::new("/v/3")));
        assert_eq!(vaults.recent.len(), RECENT_LIMIT);
        assert_eq!(vaults.recent[0], PathBuf::from("/v/3"));
        assert_eq!(vaults.recent.iter().filter(|p| p.ends_with("3")).count(), 1);
        vaults.forget(Path::new("/v/3"));
        assert!(vaults.current.is_none() && !vaults.recent.contains(&PathBuf::from("/v/3")));
    }

    #[test]
    fn file_round_trips_and_missing_file_is_empty() {
        let dir = std::env::temp_dir().join(format!("graite-vaults-{}", std::process::id()));
        let file = dir.join("nested").join("vaults.json");
        assert_eq!(load_from(&file), Vaults::default());
        let mut vaults = Vaults::default();
        vaults.remember(Path::new("/tmp/one"));
        save_to(&file, &vaults).unwrap();
        assert_eq!(load_from(&file), vaults);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn inspect_tells_pages_from_other_files() {
        let dir = std::env::temp_dir().join(format!("graite-inspect-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Projects")).unwrap();
        std::fs::write(dir.join("Projects").join("page.md"), "---\n---\n").unwrap();
        std::fs::create_dir_all(dir.join(".graite")).unwrap();
        std::fs::create_dir_all(dir.join("_agents")).unwrap();
        std::fs::write(dir.join("AGENTS.md"), "# Instructions\n").unwrap();
        let probe = inspect(&dir);
        assert!(probe.exists && probe.is_dir && probe.has_graite);
        assert_eq!(probe.pages, 1);
        assert!(!probe.other_files);
        std::fs::write(dir.join("photo.jpg"), b"x").unwrap();
        assert!(inspect(&dir).other_files);
        let missing = inspect(&dir.join("nope"));
        assert!(!missing.exists && missing.pages == 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
