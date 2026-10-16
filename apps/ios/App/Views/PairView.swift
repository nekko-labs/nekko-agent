import AVFoundation
import NekkoKit
import NekkoProtocol
import SwiftUI

/// First run: what the app is, and how to connect (Tailscale first).
struct WelcomeView: View {
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                CatMark().frame(width: 56, height: 56).foregroundStyle(palette.accent).padding(.top, 24)
                Text("Your agent, in your pocket").font(.largeTitle.weight(.bold)).foregroundStyle(palette.ink)
                Text("Drive Nekko Agent on your computer from this iPhone: follow chats as they stream, approve tools, answer questions and start new work. Everything is end-to-end encrypted between this phone and your computer.")
                    .foregroundStyle(palette.inkSoft)
                TailscaleGuide()
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
            if case .pair = r { PairView {} }
        }
        .background(palette.paper)
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
            step(2, "On the computer, run the private relay: `npm run relay:tailscale` (or `scripts/private-relay.sh`). It prints a ws://<name>.<tailnet>.ts.net:4400 address.")
            step(3, "In Nekko Agent on the computer: Settings → Remote access, paste that address as the relay, turn Remote access on and show the pairing code.")
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
                Button("Pair") { submit(pasted) }.disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty || busy)
            } header: {
                SectionHeader("Or paste the pairing link")
            }
            if let error {
                Section { Text(error).foregroundStyle(palette.danger).font(.footnote) }
            }
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
        .presentationDetents([.medium])
    }
}

func routeName(_ r: RelayRoute) -> String {
    switch r {
    case .tailscale: return "Tailscale"
    case .lan: return "Local network"
    case .loopback: return "This device"
    case .internet: return "Internet relay"
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
        private var preview: AVCaptureVideoPreviewLayer?
        private var lastCode: String?
        private var lastAt = Date.distantPast

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            let s = session
            DispatchQueue.global(qos: .userInitiated).async { if !s.isRunning { s.startRunning() } }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let s = session
            DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, Pairing.parse(code) != nil else { return }
            // Delivered on the main queue (setMetadataObjectsDelegate above).
            MainActor.assumeIsolated {
                // The same code again after a pause is a retry (say, after turning
                // Tailscale on); without the pause one scan would fire many times.
                guard code != lastCode || Date().timeIntervalSince(lastAt) > 3 else { return }
                lastCode = code
                lastAt = Date()
                onCode?(code)
            }
        }
    }
}
