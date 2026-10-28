//! Whether a full-screen app is in front (`activity:fullscreen`), so the
//! desktop app neither raises a window nor shows a notice over a game, a
//! presentation or a full-screen video. A window that takes the foreground
//! from an exclusive-fullscreen game knocks it out of exclusive mode, and the
//! game stays slower until it restarts.
//!
//! - Windows: `SHQueryUserNotificationState`, the shell's own answer to "may I
//!   interrupt now?" (what Windows uses to hold back its own toasts).
//! - Elsewhere: not read; nothing is ever held back.

/// What the shell says about interrupting the user now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Foreground {
    /// Nothing full-screen: notices and windows may come forward.
    Free,
    /// A Direct3D app in exclusive fullscreen (most games).
    D3dFullscreen,
    /// Another full-screen app (borderless games, video, a browser in F11).
    Busy,
    /// Presentation settings are on.
    Presentation,
}

impl Foreground {
    /// Whether to hold notices back and leave the foreground alone.
    pub fn quiet(self) -> bool {
        self != Foreground::Free
    }

    /// The name sent over the wire.
    pub fn name(self) -> &'static str {
        match self {
            Foreground::Free => "free",
            Foreground::D3dFullscreen => "d3dFullscreen",
            Foreground::Busy => "busy",
            Foreground::Presentation => "presentation",
        }
    }
}

/// `QUERY_USER_NOTIFICATION_STATE` to `Foreground`. Locked screens, quiet time
/// and the rest are Windows' own business (it holds its toasts itself), so
/// they count as free.
pub fn from_quns(state: i32) -> Foreground {
    match state {
        2 => Foreground::Busy,
        3 => Foreground::D3dFullscreen,
        4 => Foreground::Presentation,
        _ => Foreground::Free,
    }
}

/// The state now; `Free` whenever it cannot be read.
pub fn foreground() -> Foreground {
    platform::quns().map_or(Foreground::Free, from_quns)
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::UI::Shell::{QUERY_USER_NOTIFICATION_STATE, SHQueryUserNotificationState};

    pub fn quns() -> Option<i32> {
        let mut state: QUERY_USER_NOTIFICATION_STATE = 0;
        // SAFETY: `state` is valid for the write.
        (unsafe { SHQueryUserNotificationState(&mut state) } >= 0).then_some(state)
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn quns() -> Option<i32> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_full_screen_states_are_quiet() {
        assert_eq!(from_quns(3), Foreground::D3dFullscreen);
        assert_eq!(from_quns(2), Foreground::Busy);
        assert_eq!(from_quns(4), Foreground::Presentation);
        // Not present (locked), accepts notifications, quiet time, a Store app.
        for free in [1, 5, 6, 7, 0, -1] {
            assert!(!from_quns(free).quiet(), "{free}");
        }
        assert!(from_quns(3).quiet() && from_quns(2).quiet() && from_quns(4).quiet());
    }
}
