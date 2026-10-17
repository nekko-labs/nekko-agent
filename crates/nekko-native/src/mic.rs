//! `voice:permission`: the microphone permission as Electron main answered
//! it (`systemPreferences.getMediaAccessStatus('microphone')`).
//!
//! Windows reads the privacy setting through
//! `Windows.Devices.Enumeration.DeviceAccessInformation` for the audio
//! capture class, exactly as Electron does (and, like Electron, answers
//! `granted` when that API is unavailable). macOS asks AVFoundation for the
//! authorization status, and `request` prompts once. Linux has no such
//! setting: `unknown`, which is what the app reported before.

use serde_json::{Value, json};

/// What the renderer asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Status,
    Request,
    Settings,
}

impl Action {
    /// The action name, refused as Electron main refused it.
    pub fn parse(v: &Value) -> Result<Self, String> {
        match v.as_str().unwrap_or("status") {
            "status" => Ok(Self::Status),
            "request" => Ok(Self::Request),
            "settings" => Ok(Self::Settings),
            _ => Err("Unknown microphone permission action".into()),
        }
    }
}

/// Where each platform keeps the microphone switch (`settings`).
pub fn settings_url() -> Option<&'static str> {
    if cfg!(windows) {
        Some("ms-settings:privacy-microphone")
    } else if cfg!(target_os = "macos") {
        Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    } else {
        None
    }
}

/// Electron's `ConvertDeviceAccessStatus` (Windows) and its AVFoundation
/// mapping (macOS): 0 not determined, 1 allowed / restricted ... see each.
#[cfg(windows)]
fn status() -> String {
    use windows::Devices::Enumeration::{DeviceAccessInformation, DeviceAccessStatus, DeviceClass};
    let read = || -> windows::core::Result<DeviceAccessStatus> {
        DeviceAccessInformation::CreateFromDeviceClass(DeviceClass::AudioCapture)?.CurrentStatus()
    };
    // Electron answers "granted" when the API itself fails.
    match read().unwrap_or(DeviceAccessStatus::Allowed) {
        DeviceAccessStatus::Unspecified => "not-determined",
        DeviceAccessStatus::Allowed => "granted",
        DeviceAccessStatus::DeniedBySystem => "restricted",
        DeviceAccessStatus::DeniedByUser => "denied",
        _ => "unknown",
    }
    .into()
}

#[cfg(target_os = "macos")]
fn status() -> String {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    // SAFETY: a class method taking a constant AVFoundation provides.
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return "unknown".into() };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::NotDetermined => "not-determined",
        AVAuthorizationStatus::Restricted => "restricted",
        AVAuthorizationStatus::Denied => "denied",
        AVAuthorizationStatus::Authorized => "granted",
        _ => "unknown",
    }
    .into()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn status() -> String {
    "unknown".into()
}

/// `askForMediaAccess('microphone')`: prompts while the answer is not yet
/// determined, waiting for the user (at most two minutes).
#[cfg(target_os = "macos")]
fn request() {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return };
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let done = RcBlock::new(move |_granted: Bool| {
        let _ = tx.send(());
    });
    // SAFETY: the block lives until AVFoundation calls it (it retains it).
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &done) };
    let _ = rx.recv_timeout(std::time::Duration::from_secs(120));
}

#[cfg(not(target_os = "macos"))]
fn request() {}

/// `voice:permission`: `{ platform, status }`, after prompting (`request`,
/// macOS only, as before) or opening the privacy settings (`settings`).
pub fn permission(action: Action, platform: &str) -> Value {
    match action {
        Action::Request => request(),
        Action::Settings => {
            if let Some(url) = settings_url() {
                let _ = crate::shell::open_external(url);
            }
        }
        Action::Status => {}
    }
    json!({ "platform": platform, "status": status() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_unknown_actions_and_defaults_to_status() {
        assert_eq!(Action::parse(&Value::Null), Ok(Action::Status));
        assert_eq!(Action::parse(&json!("request")), Ok(Action::Request));
        assert_eq!(Action::parse(&json!("grant")), Err("Unknown microphone permission action".into()));
    }

    #[test]
    fn answers_one_of_electrons_statuses() {
        let s = permission(Action::Status, "x")["status"].as_str().unwrap().to_string();
        assert!(["not-determined", "granted", "denied", "restricted", "unknown"].contains(&s.as_str()), "{s}");
        if !cfg!(any(windows, target_os = "macos")) {
            assert_eq!(s, "unknown");
        }
    }
}
