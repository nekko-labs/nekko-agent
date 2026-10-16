//! Native dialogs drawn by the engine daemon, owned by the app's window.
//!
//! Windows: the common item dialog (`IFileDialog`) and a task dialog, with
//! the app window's `HWND` as owner, so they sit in front of it, disable it
//! while open and move with it, though they live in another process.
//! Linux: the XDG desktop portal, parented by the window's X11 id (zenity
//! where no portal runs). macOS: an AppKit panel can only be a sheet on a
//! window of its own process, and the daemon's main thread is not an AppKit
//! run loop, so there the daemon asks the app to draw them (see nekkod's
//! `native.rs`); `supported()` says which.

use serde::Deserialize;
use serde_json::Value;

/// Whether this platform draws dialogs in the daemon itself.
pub fn supported() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

/// The app window to own a dialog: an `HWND` (Windows) or an X11 window id (Linux).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parent(pub u64);

/// A file filter, as Electron's `{ name, extensions }`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Filter {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

/// The options the open/save dialogs take (a subset of Electron's).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileOptions {
    pub title: Option<String>,
    pub default_path: Option<String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// Open dialogs: more than one file.
    #[serde(default)]
    pub multiple: bool,
}

impl FileOptions {
    pub fn from_value(v: &Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }
}

/// A message box: Electron's `showMessageBox` options (up to three buttons).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageOptions {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub detail: String,
    pub title: Option<String>,
    /// `info`, `warning`, `error` (anything else: info).
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub buttons: Vec<String>,
    /// The button Escape and closing the box answer (`cancelId`).
    pub cancel_id: Option<usize>,
}

impl MessageOptions {
    pub fn from_value(v: &Value) -> Result<Self, String> {
        let o: Self = serde_json::from_value(v.clone()).map_err(|e| format!("Invalid message box: {e}"))?;
        if o.buttons.len() > 3 {
            return Err("A message box has at most three buttons.".into());
        }
        Ok(o)
    }

    /// The labels shown (one OK button when none are given).
    pub fn labels(&self) -> Vec<String> {
        if self.buttons.is_empty() { vec!["OK".into()] } else { self.buttons.clone() }
    }

    /// Which button a dialog's answer was: its label's index, the cancel
    /// button for a dismissed box (Electron's `cancelId`, else 0).
    pub fn answer(&self, label: Option<&str>) -> usize {
        let labels = self.labels();
        label.and_then(|l| labels.iter().position(|b| b == l)).unwrap_or(self.cancel_id.unwrap_or(0))
    }
}

/// Run a blocking dialog on a fresh thread (each initializes its own COM
/// apartment on Windows), waiting for the user without holding a runtime thread.
async fn on_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("nekko-dialog".into())
        .spawn(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "The dialog closed unexpectedly.".to_string())
}

#[cfg(any(windows, target_os = "linux"))]
mod imp {
    use super::*;
    use raw_window_handle::{
        DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle, WindowHandle,
    };

    /// Another process's window, as raw-window-handle wants it.
    pub struct Foreign(pub u64);

    impl HasWindowHandle for Foreign {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            #[cfg(windows)]
            let raw = {
                let hwnd = std::num::NonZeroIsize::new(self.0 as isize).ok_or(HandleError::Unavailable)?;
                RawWindowHandle::Win32(raw_window_handle::Win32WindowHandle::new(hwnd))
            };
            #[cfg(target_os = "linux")]
            let raw = RawWindowHandle::Xlib(raw_window_handle::XlibWindowHandle::new(self.0 as _));
            // SAFETY: the handle is only read by the dialog backend while the
            // dialog is open; a window that closes meanwhile is a stale id the
            // OS rejects, not memory we touch.
            Ok(unsafe { WindowHandle::borrow_raw(raw) })
        }
    }

    impl HasDisplayHandle for Foreign {
        fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
            #[cfg(windows)]
            let raw = RawDisplayHandle::Windows(raw_window_handle::WindowsDisplayHandle::new());
            #[cfg(target_os = "linux")]
            let raw = RawDisplayHandle::Xlib(raw_window_handle::XlibDisplayHandle::new(None, 0));
            // SAFETY: see above; no display pointer is passed.
            Ok(unsafe { DisplayHandle::borrow_raw(raw) })
        }
    }

    pub fn file_dialog(parent: Option<Parent>, o: &FileOptions) -> rfd::FileDialog {
        let mut d = rfd::FileDialog::new();
        if let Some(t) = &o.title {
            d = d.set_title(t);
        }
        if let Some(p) = &o.default_path {
            let path = std::path::Path::new(p);
            if path.is_dir() {
                d = d.set_directory(path);
            } else {
                if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
                    d = d.set_directory(dir);
                }
                if let Some(name) = path.file_name() {
                    d = d.set_file_name(name.to_string_lossy());
                }
            }
        }
        for f in &o.filters {
            // Electron's `*` means every file; the dialogs want no filter for that.
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).filter(|e| *e != "*").collect();
            if !exts.is_empty() {
                d = d.add_filter(&f.name, &exts);
            }
        }
        if let Some(p) = parent {
            d = d.set_parent(&Foreign(p.0));
        }
        d
    }

    pub fn message(parent: Option<Parent>, o: &MessageOptions) -> usize {
        use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
        let labels = o.labels();
        let buttons = match labels.as_slice() {
            [a] => MessageButtons::OkCustom(a.clone()),
            [a, b] => MessageButtons::OkCancelCustom(a.clone(), b.clone()),
            [a, b, c] => MessageButtons::YesNoCancelCustom(a.clone(), b.clone(), c.clone()),
            _ => MessageButtons::Ok,
        };
        let level = match o.kind.as_str() {
            "warning" => MessageLevel::Warning,
            "error" => MessageLevel::Error,
            _ => MessageLevel::Info,
        };
        let mut description = o.message.clone();
        if !o.detail.is_empty() {
            description =
                if description.is_empty() { o.detail.clone() } else { format!("{description}\n\n{}", o.detail) };
        }
        let mut d = MessageDialog::new()
            .set_level(level)
            .set_title(o.title.clone().unwrap_or_else(|| "Nekko Agent".into()))
            .set_description(description)
            .set_buttons(buttons);
        if let Some(p) = parent {
            d = d.set_parent(&Foreign(p.0));
        }
        // Windows draws MessageBoxW here (custom labels need comctl32 v6,
        // which the daemon's manifest-less binary does not load), so its
        // buttons are the system's OK / OK Cancel / Yes No Cancel, in the
        // order the labels were given. Cancel is also Escape.
        match d.show() {
            MessageDialogResult::Custom(l) => o.answer(Some(&l)),
            MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
            MessageDialogResult::No => 1,
            MessageDialogResult::Cancel => o.cancel_id.unwrap_or(labels.len().saturating_sub(1)),
        }
    }
}

fn paths(v: Option<Vec<std::path::PathBuf>>) -> Vec<String> {
    v.unwrap_or_default().into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Open one or more files: the paths, empty when cancelled.
pub async fn open_files(parent: Option<Parent>, o: FileOptions) -> Result<Vec<String>, String> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        on_thread(move || {
            let d = imp::file_dialog(parent, &o);
            if o.multiple { paths(d.pick_files()) } else { paths(d.pick_file().map(|p| vec![p])) }
        })
        .await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (parent, o, paths(None));
        Err("Native dialogs are drawn by the app on this platform.".into())
    }
}

/// Choose a folder: its path, `None` when cancelled.
pub async fn pick_folder(parent: Option<Parent>, o: FileOptions) -> Result<Option<String>, String> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        on_thread(move || imp::file_dialog(parent, &o).pick_folder().map(|p| p.to_string_lossy().into_owned())).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (parent, o);
        Err("Native dialogs are drawn by the app on this platform.".into())
    }
}

/// Choose where to save: the path, `None` when cancelled.
pub async fn save_file(parent: Option<Parent>, o: FileOptions) -> Result<Option<String>, String> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        on_thread(move || imp::file_dialog(parent, &o).save_file().map(|p| p.to_string_lossy().into_owned())).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (parent, o);
        Err("Native dialogs are drawn by the app on this platform.".into())
    }
}

/// A message box: the index of the button chosen (`showMessageBox`'s `response`).
pub async fn message(parent: Option<Parent>, o: MessageOptions) -> Result<usize, String> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        on_thread(move || imp::message(parent, &o)).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (parent, o);
        Err("Native dialogs are drawn by the app on this platform.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_options_answer_like_electron() {
        let o =
            MessageOptions::from_value(&json!({ "message": "Move?", "buttons": ["Cancel", "Move"], "cancelId": 0 }))
                .unwrap();
        assert_eq!(o.answer(Some("Move")), 1);
        assert_eq!(o.answer(None), 0, "a dismissed box answers the cancel button");
        let none = MessageOptions::from_value(&json!({ "message": "Hi" })).unwrap();
        assert_eq!(none.labels(), vec!["OK".to_string()]);
        assert!(MessageOptions::from_value(&json!({ "buttons": ["a", "b", "c", "d"] })).is_err());
    }

    #[test]
    fn file_options_read_electrons_shape() {
        let o = FileOptions::from_value(
            &json!({ "title": "Pick", "filters": [{ "name": "Models", "extensions": ["bin"] }], "multiple": true }),
        );
        assert_eq!(o.title.as_deref(), Some("Pick"));
        assert!(o.multiple);
        assert_eq!(o.filters[0].extensions, vec!["bin".to_string()]);
        assert_eq!(FileOptions::from_value(&json!(null)), FileOptions::default());
    }
}
