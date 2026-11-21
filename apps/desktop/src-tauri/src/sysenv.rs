//! The environment for programs that are not part of the app (D124).
//!
//! An AppImage starts the app with its own folders first in `PATH`, `LD_LIBRARY_PATH`,
//! `XDG_DATA_DIRS` and a dozen GTK, GIO, GStreamer and Python variables. A program started
//! from the app inherits all of it and then loads the app's older libraries: `xdg-open`'s
//! `gio` stops with a symbol error and a folder ends up in the web browser, and an engine the
//! daemon starts cannot load at all. So everything the shell starts gets the environment the
//! app itself was started from, with the AppImage's folders taken out again.

/// Says where the app lives; the daemon reads these (`graite/api/mcp.py`). Never changed.
const KEPT: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

fn inside_app(entry: &str, appdir: &str) -> bool {
    let appdir = appdir.trim_end_matches('/');
    entry == appdir
        || entry.strip_prefix(appdir).is_some_and(|rest| rest.starts_with('/'))
        // A mount left in the environment by the copy that ran before an update in place.
        || entry.split('/').any(|part| part.starts_with(".mount_"))
}

/// What one variable becomes for a program outside the app: `None` leaves it as it is,
/// `Some(None)` removes it, `Some(Some(value))` sets the cleaned value.
fn cleaned(name: &str, value: &str, appdir: &str) -> Option<Option<String>> {
    if KEPT.contains(&name) {
        return None;
    }
    let entries: Vec<&str> = value.split(':').collect();
    if !entries.iter().any(|entry| inside_app(entry, appdir)) {
        return None;
    }
    let kept: Vec<&str> = entries
        .into_iter()
        .filter(|entry| !entry.is_empty() && !inside_app(entry, appdir))
        .collect();
    Some(if kept.is_empty() {
        None
    } else {
        Some(kept.join(":"))
    })
}

/// The changes to make to a child's environment: `(name, None)` removes the variable.
/// Empty unless the app runs from an AppImage on Linux.
pub fn changes() -> Vec<(String, Option<String>)> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let Ok(appdir) = std::env::var("APPDIR") else {
        return Vec::new();
    };
    if appdir.is_empty() {
        return Vec::new();
    }
    std::env::vars()
        .filter_map(|(name, value)| cleaned(&name, &value, &appdir).map(|change| (name, change)))
        .collect()
}

/// Give `command` the system's environment (see the module text).
pub fn apply(command: &mut std::process::Command) {
    for (name, value) in changes() {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::cleaned;

    const APP: &str = "/tmp/.mount_GraiteAb12";

    #[test]
    fn app_folders_leave_a_list_and_the_rest_stays_in_order() {
        let path = "/tmp/.mount_GraiteAb12/usr/bin/:/tmp/.mount_GraiteOld9/usr/bin/:/usr/local/bin:/usr/bin";
        assert_eq!(
            cleaned("PATH", path, APP),
            Some(Some("/usr/local/bin:/usr/bin".into()))
        );
    }

    #[test]
    fn a_variable_that_only_points_into_the_app_is_removed() {
        let modules = "/tmp/.mount_GraiteAb12/usr/lib/aarch64-linux-gnu/gio/modules";
        assert_eq!(cleaned("GIO_EXTRA_MODULES", modules, APP), Some(None));
        assert_eq!(
            cleaned("PYTHONHOME", "/tmp/.mount_GraiteAb12/usr/", APP),
            Some(None)
        );
        // A trailing separator is not a folder of the user's.
        assert_eq!(
            cleaned(
                "PYTHONPATH",
                "/tmp/.mount_GraiteAb12/usr/share/pyshared/:",
                APP
            ),
            Some(None)
        );
    }

    #[test]
    fn other_variables_and_the_apps_own_markers_are_left_alone() {
        assert_eq!(cleaned("HOME", "/home/me", APP), None);
        assert_eq!(cleaned("GDK_BACKEND", "x11", APP), None);
        assert_eq!(cleaned("APPDIR", APP, APP), None);
        assert_eq!(cleaned("APPIMAGE", "/home/me/Graite.AppImage", APP), None);
        // Starting with the same letters is not being inside the app.
        assert_eq!(cleaned("X", "/opt/app-other/lib", "/opt/app"), None);
        assert_eq!(
            cleaned("X", "/opt/app/lib:/usr/lib", "/opt/app"),
            Some(Some("/usr/lib".into()))
        );
    }
}
