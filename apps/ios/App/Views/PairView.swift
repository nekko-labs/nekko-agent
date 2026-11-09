// The capture session is started and stopped on its own serial queue, as Apple
// recommends, but AVFoundation does not mark it Sendable yet.
@preconcurrency import AVFoundation
import NekkoKit
import NekkoProtocol
import SwiftUI

/// First run: what the app is, and how to connect (Tailscale first).
struct WelcomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // First run, step 2 of 3 (IO-31).
                if !app.prefs.onboarded { StepLabel(step: 2).padding(.top, 8) }
                BrandMark().frame(width: 64, height: 64).padding(.top, 24)
                Text("Your agent, in your pocket").font(.largeTitle.weight(.bold)).foregroundStyle(palette.ink)
                Text("Drive Nekko Agent on your computer from this iPhone: follow chats as they stream, approve tools, answer questions and start new work. Everything is end-to-end encrypted between this phone and your computer.")
                    .foregroundStyle(palette.inkSoft)
                TailscaleGuide()
                // Synced chats are readable with no computer paired or online.
                if app.prefs.onboarded {
                    NavigationLink(value: Route.cloud) {
                        Label("Read your synced chats with Nekko Cloud", systemImage: "lock.icloud")
                    }
                    .accessibilityIdentifier("welcome.cloud")
                }
                // No computer needed: chats can run on this iPhone, on a cloud provider (decision 0050).
                NavigationLink(value: Route.phoneModels) {
                    Label("Or use a model provider on this iPhone", systemImage: "iphone")
                }
                .accessibilityIdentifier("welcome.phoneModels")
            }
            .padding(20)
        }
        // Pinned so the one action stays on screen at the largest text sizes.
        .safeAreaInset(edge: .bottom) {
            NavigationLink(value: Route.pair) {
                Label("Pair with your computer", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(.vertical, 6)
                    .foregroundStyle(palette.onAccent)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.bar)
        }
        .navigationDestination(for: Route.self) { r in
            switch r {
            case .pair: PairView {}
            case .cloud: CloudView()
            case .syncedChat(let id): SyncedChatView(chatId: id)
            case .phoneModels: PhoneModelsView()
            default: EmptyView()
            }
        }
        .toolbar {
            if !app.prefs.onboarded {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Skip") { app.prefs.onboarded = true }.accessibilityIdentifier("firstRun.skip")
                }
            }
        }
        .background { AppBackdrop() }
    }
}

/// How to reach the computer: Tailscale (private, recommended), or the Nekko relay.
struct TailscaleGuide: View {
    @Environment(\.palette) private var palette
    @State private var tailnet = Tailnet.isConnected
    @Environment(\.scenePhase) private var phase

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect over Tailscale (recommended)").font(.headline).foregroundStyle(palette.ink)
            step(1, "Install Tailscale on your computer and this iPhone, and sign in to the same tailnet.")
            step(2, "In Nekko Agent on the computer: Settings → Remote access → Relay on this computer → Start relay, then Use this relay.")
            step(3, "Turn Remote access on and choose Pair a phone to show the pairing code.")
            step(4, "Scan the code here. Traffic stays inside your tailnet (WireGuard) and is end-to-end encrypted on top.")
            HStack(spacing: 8) {
                Circle().fill(tailnet ? palette.success : palette.inkFaint).frame(width: 8, height: 8)
                Text(tailnet ? "Tailscale is connected on this iPhone." : "Tailscale isn’t connected on this iPhone right now.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
            }
            if !tailnet {
                Link("Get Tailscale for iPhone", destination: URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!).font(.footnote)
                    .frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            Divider().padding(.vertical, 4)
            Text("No Tailscale?").font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
            Text("Use a wss:// relay instead: the Nekko relay or one you host. The relay only ever sees encrypted frames.")
                .font(.footnote).foregroundStyle(palette.inkSoft)
        }
        .padding(16)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.line))
        .onAppear { tailnet = Tailnet.isConnected }
        // Back from the Tailscale app: show the new state.
        .onChange(of: phase) { _, p in if p == .active { tailnet = Tailnet.isConnected } }
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.caption.weight(.bold)).frame(width: 22, height: 22)
                .background(palette.accent.opacity(0.15), in: Circle()).foregroundStyle(palette.accent)
            Text(text).font(.subheadline).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Scan the computer's QR code, or paste its pairing link.
struct PairView: View {
    var done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var pasted = ""
    @State private var error: String?
    @State private var busy = false
    @State private var cameraDenied = false

    var body: some View {
        List {
            Section {
                ZStack {
                    if cameraDenied {
                        VStack(spacing: 10) {
                            Text("Camera access is off. Allow it in Settings → Nekko Agent, or paste the link below.")
                                .font(.footnote).multilineTextAlignment(.center)
                            Link("Open Settings", destination: URL(string: UIApplication.openSettingsURLString)!)
                                .font(.footnote.weight(.semibold))
                        }
                        .padding()
                    } else {
                        QRScanner { code in submit(code) }
                    }
                }
                .frame(height: 280)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .listRowInsets(EdgeInsets())
            } footer: {
                Text("On the computer: Settings → Remote access → Pair a phone.").foregroundStyle(palette.inkSoft)
            }
            Section {
                TextField("nekko-agent-pair:?relay=…", text: $pasted, axis: .vertical)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().font(.footnote.monospaced())
                HStack(spacing: 12) {
                    // The system Paste button reads the clipboard without the
                    // "allow paste" prompt (Android has the same button).
                    PasteButton(payloadType: String.self) { strings in
                        if let s = strings.first { pasted = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                    Spacer()
                    Button("Pair") { submit(pasted) }.disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
                // Two buttons in one list row: each takes only its own taps.
                .buttonStyle(.borderless)
            } header: {
                SectionHeader("Or paste the pairing link")
            }
            if let error {
                Section { Text(error).foregroundStyle(palette.danger).font(.footnote) }
            }
            NearbySection()
            Section { TailscaleGuide().listRowInsets(EdgeInsets()) }
        }
        .navigationTitle("Pair")
        .keyboardDoneButton()
        .overlay { if busy { ProgressView("Pairing…").padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)) } }
        .task {
            if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                cameraDenied = !(await AVCaptureDevice.requestAccess(for: .video))
            } else {
                cameraDenied = AVCaptureDevice.authorizationStatus(for: .video) != .authorized
            }
        }
    }

    private func submit(_ text: String) {
        guard !busy else { return }
        guard let link = Pairing.parse(text) else {
            error = "That isn’t a Nekko Agent pairing link."
            return
        }
        busy = true
        Haptics.tap()
        Task {
            error = await app.pair(link)
            busy = false
            if error == nil { done() }
        }
    }
}

/// Computers on this Wi-Fi that say they run Nekko Agent (the desktop's
/// *Visible on this network*). A pointer only: their record holds no secrets,
/// so pairing still takes the computer's code. Looks only when asked.
struct NearbySection: View {
    @Environment(\.palette) private var palette
    @State private var browser = NearbyBrowser()

    var body: some View {
        Section {
            ForEach(browser.found) { c in
                VStack(alignment: .leading, spacing: 2) {
                    Label(c.name, systemImage: "desktopcomputer").foregroundStyle(palette.ink)
                    Text(c.relayUrl.map { "Runs its own relay: \(Pairing.relayHost($0))" } ?? "On this network")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                }
                .accessibilityElement(children: .combine)
            }
            if browser.state == .looking {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Looking…").foregroundStyle(palette.inkSoft)
                }
                .frame(minHeight: 44)
            } else {
                Button(browser.looked || !browser.found.isEmpty ? "Look again" : "Look on this network") { browser.start() }
                    .frame(minHeight: 44)
            }
            if browser.state == .denied {
                Text("Local network access is off for Nekko Agent. Turn it on in Settings → Privacy & Security → Local Network.")
                    .font(.footnote).foregroundStyle(palette.danger)
                Link("Open Settings", destination: URL(string: UIApplication.openSettingsURLString)!).font(.footnote.weight(.semibold))
                    .frame(minHeight: 44, alignment: .leading)
            } else if case .failed(let message) = browser.state {
                Text("Couldn’t look on this network: \(message)").font(.footnote).foregroundStyle(palette.danger)
            } else if browser.looked && browser.found.isEmpty && browser.state == .idle {
                Text("No computers found. On the computer, turn on Settings → Remote access → Visible on this network. Some Wi-Fi networks (offices, hotels) block this; the code always works.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
            }
        } header: {
            SectionHeader("On this network")
        } footer: {
            Text("Finding a computer doesn’t pair with it. On the computer you want: Settings → Remote access → Pair a phone, then scan its code above.")
                .foregroundStyle(palette.inkSoft)
        }
        .onDisappear { browser.stop() }
    }
}

/// A link opened from outside the app (camera, another app): confirm before pairing.
struct ConfirmPairSheet: View {
    let link: PairingLink
    var done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Relay", value: Pairing.relayHost(link.relayUrl))
                    LabeledContent("Route", value: routeName(RelayRoute.of(link.relayUrl)))
                    LabeledContent("One-time code", value: link.pair == nil ? "None (re-pairing)" : "Included")
                } footer: {
                    Text("Only pair with a computer you own. It will be able to send this iPhone its chats, and this iPhone will be able to run tools on it.")
                }
                if let error { Text(error).foregroundStyle(palette.danger) }
            }
            .navigationTitle("Pair with a computer?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair") {
                        busy = true
                        Task {
                            error = await app.pair(link)
                            busy = false
                            if error == nil {
                                dismiss()
                                done()
                            }
                        }
                    }.disabled(busy)
                }
            }
        }
        // Large too: at accessibility text sizes the confirmation does not fit in half the screen.
        .presentationDetents([.medium, .large])
    }
}

func routeName(_ r: RelayRoute) -> String {
    switch r {
    case .tailscale: return "Tailscale"
    case .lan: return String(localized: "Local network")
    case .loopback: return String(localized: "This device")
    case .internet: return String(localized: "Internet relay")
    }
}

/// AVFoundation QR scanner; reports the first code that parses as a pairing link.
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.onCode = onCode
        return c
    }

    func updateUIViewController(_ vc: ScannerController, context: Context) { vc.onCode = onCode }

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        /// One serial queue for starting and stopping: on a concurrent queue a quick
        /// open and close could stop before it started, leaving the camera on.
        private let sessionQueue = DispatchQueue(label: "nekko.capture")
        /// Codes are reported here, not on the main queue: while SwiftUI lays out
        /// the list around the preview, the main queue delivered them late.
        private let metadataQueue = DispatchQueue(label: "nekko.capture.codes")
        private var preview: AVCaptureVideoPreviewLayer?
        /// Keeps the preview level with the horizon as the device turns (iPad in
        /// any orientation, iPhone sideways); without it the picture stayed
        /// portrait and sideways on screen.
        private var rotation: AVCaptureDevice.RotationCoordinator?
        private var rotationWatch: NSKeyValueObservation?
        private var lastCode: String?
        private var lastAt = Date.distantPast

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                    ?? AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            Self.focusForCodes(device)
            session.beginConfiguration()
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                session.commitConfiguration()
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: metadataQueue)
            output.metadataObjectTypes = [.qr]
            session.commitConfiguration()
            // After the format is settled: the zoom is worked out from its field of view.
            Self.zoomForCodes(device)
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
            rotation = coordinator
            applyRotation(coordinator.videoRotationAngleForHorizonLevelPreview)
            rotationWatch = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] c, _ in
                let angle = c.videoRotationAngleForHorizonLevelPreview
                Task { @MainActor in self?.applyRotation(angle) }
            }
        }

        private func applyRotation(_ angle: CGFloat) {
            guard let connection = preview?.connection, connection.isVideoRotationAngleSupported(angle) else { return }
            connection.videoRotationAngle = angle
        }

        /// A pairing code is held close: keep refocusing, favour near subjects,
        /// and aim focus and exposure at the middle, where the code is framed.
        private static func focusForCodes(_ device: AVCaptureDevice) {
            guard (try? device.lockForConfiguration()) != nil else { return }
            defer { device.unlockForConfiguration() }
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isAutoFocusRangeRestrictionSupported { device.autoFocusRangeRestriction = .near }
            if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = CGPoint(x: 0.5, y: 0.5) }
            if device.isExposurePointOfInterestSupported {
                device.exposurePointOfInterest = CGPoint(x: 0.5, y: 0.5)
                if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            }
        }

        /// The main camera on recent iPhones cannot focus closer than about 20 cm,
        /// and the code on a laptop screen is a few centimetres across, so people
        /// brought the phone closer, out of focus, and nothing scanned. Zoom in
        /// just enough that a 4 cm code fills half the frame at that distance
        /// (Apple's AVCamBarcode approach), at most 2x so it is still easy to aim.
        /// iPads and older iPhones focus closer and stay at 1x.
        private static func zoomForCodes(_ device: AVCaptureDevice) {
            let nearest = device.minimumFocusDistance // millimetres; -1 when unknown
            guard nearest > 0 else { return }
            let zoom = PairScanZoom.factor(
                minimumFocusDistance: Double(nearest),
                fieldOfView: Double(device.activeFormat.videoFieldOfView),
                maxZoom: Double(device.activeFormat.videoMaxZoomFactor)
            )
            guard zoom > 1, (try? device.lockForConfiguration()) != nil else { return }
            device.videoZoomFactor = CGFloat(zoom)
            device.unlockForConfiguration()
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            // No implicit animation: the frame follows the rotation at once.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            preview?.frame = view.bounds
            CATransaction.commit()
            if let rotation { applyRotation(rotation.videoRotationAngleForHorizonLevelPreview) }
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            let s = session
            sessionQueue.async { if !s.isRunning { s.startRunning() } }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let s = session
            sessionQueue.async { if s.isRunning { s.stopRunning() } }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            // Any code in view that is a pairing link, not only the first one found.
            guard let code = objects.lazy.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue })
                .first(where: { Pairing.parse($0) != nil }) else { return }
            // Delivered on `metadataQueue`; the rest happens on the main actor.
            Task { @MainActor [weak self] in self?.found(code) }
        }

        private func found(_ code: String) {
            // The same code again after a pause is a retry (say, after turning
            // Tailscale on); without the pause one scan would fire many times.
            guard code != lastCode || Date().timeIntervalSince(lastAt) > 3 else { return }
            lastCode = code
            lastAt = Date()
            onCode?(code)
        }
    }
}

/// How far the pair scanner zooms, from the camera's nearest focus distance.
enum PairScanZoom {
    /// The smallest code we expect, in millimetres: the desktop's code on a laptop screen.
    static let codeWidth = 40.0
    /// How much of the frame's width that code should fill at the nearest focus.
    static let fill = 0.5
    /// More than this and the preview jumps around too much to aim.
    static let cap = 2.0

    /// `minimumFocusDistance` in millimetres, `fieldOfView` in degrees (horizontal).
    static func factor(minimumFocusDistance: Double, fieldOfView: Double, maxZoom: Double) -> Double {
        guard minimumFocusDistance > 0, fieldOfView > 0 else { return 1 }
        // The distance at which a frame `codeWidth / fill` wide fills the field of view.
        let halfAngle = fieldOfView / 2 * .pi / 180
        let distance = (codeWidth / fill / 2) / tan(halfAngle)
        guard distance < minimumFocusDistance else { return 1 }
        return min(minimumFocusDistance / distance, cap, max(maxZoom, 1))
    }
}
