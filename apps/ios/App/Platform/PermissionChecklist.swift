import ActivityKit
import AVFoundation
import LocalAuthentication
import Observation
import Photos
import Speech
import UIKit
import UserNotifications

/// System authorization only. No pairing, recording, photo reads or Live Activity
/// starts happen here. Requests are made by a single explicit row tap.
@MainActor @Observable
final class PermissionChecklist {
    enum Access: Equatable {
        case unknown, allowed, denied, restricted, unavailable, available, quiet

        var label: String {
            switch self {
            case .unknown: return String(localized: "Not set")
            case .allowed: return String(localized: "Allowed")
            case .denied: return String(localized: "Off in Settings")
            case .restricted: return String(localized: "Restricted by device")
            case .unavailable: return String(localized: "Not available")
            case .available: return String(localized: "Available")
            case .quiet: return String(localized: "Quiet notifications")
            }
        }

        var checked: Bool { self == .allowed || self == .quiet }
        var canRequest: Bool { self != .restricted && self != .unavailable }
    }

    enum Item: String, CaseIterable, Identifiable {
        case notifications, network, liveActivities, camera, microphone, speech, authentication, photos
        var id: String { rawValue }
        var title: String {
            switch self {
            case .notifications: return String(localized: "Alerts")
            case .network: return String(localized: "Nearby computers")
            case .liveActivities: return String(localized: "Lock Screen progress")
            case .camera: return String(localized: "Camera")
            case .microphone: return String(localized: "Microphone")
            case .speech: return String(localized: "Speech to text")
            case .authentication: return String(localized: "Face ID or passcode")
            case .photos: return String(localized: "Save to Photos")
            }
        }
        var detail: String {
            switch self {
            case .notifications: return String(localized: "Approvals, questions and finished replies.")
            case .network: return String(localized: "Find Nekko on your Wi-Fi. Never pairs on its own.")
            case .liveActivities: return String(localized: "Follow work without opening the app.")
            case .camera: return String(localized: "Scan a pairing code. Pasting a link works too.")
            case .microphone: return String(localized: "Dictate instead of typing. Never records on its own.")
            case .speech: return String(localized: "Transcribed on this device, never sent to Apple.")
            case .authentication: return String(localized: "A quick check. App lock stays as it is.")
            case .photos: return String(localized: "Save images from chats. Nekko can’t see your library.")
            }
        }
        var icon: String {
            switch self {
            case .notifications: return "bell.badge"
            case .network: return "network"
            case .liveActivities: return "rectangle.inset.filled"
            case .camera: return "qrcode.viewfinder"
            case .microphone: return "mic"
            case .speech: return "waveform"
            case .authentication: return "lock.shield"
            case .photos: return "photo.badge.plus"
            }
        }
    }

    private(set) var access: [Item: Access] = [:]
    private(set) var busy: Item?
    private(set) var message: String?
    private(set) var nearby = NearbyBrowser(lookFor: .seconds(12))

    func status(_ item: Item) -> Access {
        if item == .network {
            if nearby.state == .denied { return .denied }
            if !nearby.found.isEmpty { return .allowed }
            return .unknown
        }
        return access[item] ?? .unknown
    }

    func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .ephemeral: access[.notifications] = .allowed
        case .provisional: access[.notifications] = .quiet
        case .denied: access[.notifications] = .denied
        case .notDetermined: access[.notifications] = .unknown
        @unknown default: access[.notifications] = .unknown
        }
        access[.camera] = Self.capture(AVCaptureDevice.authorizationStatus(for: .video))
        if AVCaptureDevice.default(for: .video) == nil { access[.camera] = .unavailable }
        // Read the capture authorization on every foreground transition.
        // This also represents restricted access rather than treating it as denial.
        access[.microphone] = Self.capture(AVCaptureDevice.authorizationStatus(for: .audio))
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: access[.speech] = .allowed
        case .denied: access[.speech] = .denied
        case .restricted: access[.speech] = .restricted
        case .notDetermined: access[.speech] = .unknown
        @unknown default: access[.speech] = .unknown
        }
        if SFSpeechRecognizer() == nil { access[.speech] = .unavailable }
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited: access[.photos] = .allowed
        case .denied: access[.photos] = .denied
        case .restricted: access[.photos] = .restricted
        case .notDetermined: access[.photos] = .unknown
        @unknown default: access[.photos] = .unknown
        }
        access[.liveActivities] = ActivityAuthorizationInfo().areActivitiesEnabled ? .allowed : .denied
        var error: NSError?
        if !LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            access[.authentication] = .unavailable
        } else if access[.authentication] != .allowed {
            access[.authentication] = .available
        }
    }

    static func capture(_ status: AVAuthorizationStatus) -> Access {
        switch status {
        case .authorized: return .allowed
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .unknown
        @unknown default: return .unknown
        }
    }

    func request(_ item: Item) async {
        guard !Task.isCancelled, busy == nil, status(item).canRequest else { return }
        message = nil
        if status(item) == .denied || item == .liveActivities {
            Self.openSettings()
            return
        }
        busy = item
        defer { busy = nil }
        switch item {
        case .notifications:
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        case .network:
            nearby.start()
            // No timeout is interpreted as permission granted or denied.
            for _ in 0..<48 {
                do { try await Task.sleep(for: .milliseconds(250)) }
                catch { nearby.stop(); return }
                if nearby.state == .denied || !nearby.found.isEmpty { break }
            }
            nearby.stop()
            if status(.network) == .unknown {
                message = String(localized: "No computer found yet. Check it’s on this Wi-Fi, or turn on Local Network in Settings.")
            }
        case .camera: _ = await AVCaptureDevice.requestAccess(for: .video)
        case .microphone: _ = await AVAudioApplication.requestRecordPermission()
        case .speech:
            _ = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
        case .photos: _ = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        case .authentication:
            do {
                if try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: String(localized: "Check device authentication for Nekko Agent")) {
                    access[.authentication] = .allowed
                }
            } catch {
                message = String(localized: "Not completed. Try again anytime.")
            }
        case .liveActivities: break
        }
        await refresh()
    }

    func stop() {
        nearby.stop()
        // Local network has no public authorization getter. Never retain a
        // previous discovery as proof after returning from system Settings.
        nearby = NearbyBrowser(lookFor: .seconds(12))
    }

    static func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
