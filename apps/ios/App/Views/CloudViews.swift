import AuthenticationServices
import NekkoKit
import NekkoProtocol
import SwiftUI

/// Settings → Nekko Cloud sync: sign in, join the account's end-to-end
/// encrypted sync, approve a new computer, and read synced chats with no
/// computer online.
struct CloudView: View {
    @Environment(CloudSync.self) private var cloud
    @Environment(\.palette) private var palette
    @State private var error: String?
    @State private var busy = false
    @State private var approving: CloudSync.Device?
    @State private var approveCode = ""
    @State private var recoveryText = ""

    var body: some View {
        Group {
            if cloud.phase == .signedOut {
                CloudSignInView()
            } else {
                List {
                    Section {
                        SyncPicture(phase: cloud.phase, others: cloud.devices.filter { !$0.thisDevice && !$0.revoked }.count)
                            .frame(height: 150)
                            .listRowBackground(Color.clear)
                            .accessibilityHidden(true)
                        statusRow
                    }
                    content
                    if let error {
                        Section { Text(error).foregroundStyle(palette.danger).font(.footnote) }
                    }
                    Section {
                        if let a = cloud.account {
                            LabeledContent(a.email, value: a.plan == "team" ? "Team" : a.plan == "pro" ? "Pro" : "Free")
                        }
                        Button("Sign out", role: .destructive) { Task { await cloud.signOut() } }
                    } header: { SectionHeader("Account") } footer: {
                        Text("Signing out keeps the synced chats on this iPhone until you forget everything in Settings.").foregroundStyle(palette.inkSoft)
                    }
                }
                .pawRefreshable { await run { try await cloud.sync() } }
            }
        }
        .appBackground()
        .navigationTitle("Nekko Cloud")
        .navigationBarTitleDisplayMode(.inline)
        .task { if cloud.signedIn { await run { try await cloud.sync() } } }
        // Approving types the join code the computer shows: it checks the computer's key here, and this iPhone there.
        .alert(approving.map { "Approve \($0.label)?" } ?? "", isPresented: Binding(get: { approving != nil }, set: { if !$0 { approving = nil } }),
               presenting: approving) { d in
            TextField("XXXX-XXXX-XXXX-XXXX", text: $approveCode)
                .font(.body.monospaced()).textInputAutocapitalization(.characters).autocorrectionDisabled()
                .accessibilityIdentifier("cloud.approveCode")
            Button("Approve") {
                let code = approveCode
                approveCode = ""
                Task { await run { try await cloud.approve(deviceId: d.id, code: code) } }
            }
            Button("Cancel", role: .cancel) { approveCode = "" }
        } message: { d in
            Text("Type the code \(d.label) shows. Only approve it if it's yours: it will be able to read everything you sync.")
        }
    }

    @ViewBuilder private var statusRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(headline).font(.headline).foregroundStyle(palette.ink)
                Text(subline).font(.footnote).foregroundStyle(palette.inkSoft)
            }
            Spacer()
            if busy || cloud.syncing { ProgressView() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("cloud.status")
    }

    private var headline: String {
        switch cloud.phase {
        case .signedOut: return "Signed out"
        case .needsPlan: return "Sync isn't included"
        case .notSetUp: return "Turn sync on on your computer"
        case .needsJoin: return "Add this iPhone"
        case .awaitingApproval: return "Waiting for approval"
        case .syncing: return "Syncing…"
        case .idle: return "Up to date"
        case .error: return "Needs attention"
        }
    }

    private var subline: String {
        switch cloud.phase {
        case .needsPlan: return "Sync is part of Nekko Cloud Pro and Team."
        case .notSetUp: return "Open Settings → Sync on your computer and turn it on first."
        case .needsJoin: return "Use your recovery key, or approve this iPhone on a computer."
        case .awaitingApproval: return "Type this iPhone's code in Settings → Sync on a computer."
        case .idle, .syncing, .error:
            let n = cloud.chats.count
            let when = cloud.lastSyncAt.map { " · synced \($0.formatted(.relative(presentation: .named)))" } ?? ""
            return "\(n) chat\(n == 1 ? "" : "s"), end-to-end encrypted\(when)"
        case .signedOut: return ""
        }
    }

    @ViewBuilder private var content: some View {
        switch cloud.phase {
        case .needsJoin:
            Section {
                TextField("XXXXX-XXXXX-…", text: $recoveryText, axis: .vertical)
                    .font(.body.monospaced()).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .lineLimit(2...4).accessibilityLabel("Recovery key").accessibilityIdentifier("cloud.recoveryKey")
                Button("Unlock with the recovery key") { Task { await run { try await cloud.restore(recoveryKey: recoveryText) } } }
                    .disabled(busy || recoveryText.filter { $0.isLetter || $0.isNumber }.count < 55)
            } header: { SectionHeader("Use my recovery key") } footer: {
                Text("The 55-character key you saved when sync was turned on, or the QR code in your recovery kit.").foregroundStyle(palette.inkSoft)
            }
            Section {
                Button("Ask to join") { Task { await run { try await cloud.requestJoin() } } }.disabled(busy)
                    .accessibilityIdentifier("cloud.requestJoin")
            } header: { SectionHeader("Or approve it on a computer") } footer: {
                Text("This iPhone shows a one-time code; type it on a computer that already syncs.").foregroundStyle(palette.inkSoft)
            }
        case .awaitingApproval:
            Section {
                Text(cloud.joinCode ?? "")
                    .font(.title2.monospaced().weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                    .accessibilityLabel("Code: \(cloud.joinCode?.map { String($0) }.joined(separator: " ") ?? "")")
                    .accessibilityIdentifier("cloud.joinCode")
                Button("Check now") { Task { await run { try await cloud.sync() } } }.disabled(busy)
            } header: { SectionHeader("This iPhone's code") } footer: {
                Text("On your computer: Settings → Sync → Devices → Approve, then type this code. It proves to each device that the other is yours; don't share it with anyone else.").foregroundStyle(palette.inkSoft)
            }
        case .idle, .syncing, .error:
            Section {
                if cloud.chats.isEmpty {
                    Text("Nothing synced yet.").foregroundStyle(palette.inkSoft)
                }
                ForEach(cloud.chats) { c in
                    NavigationLink(value: Route.syncedChat(c.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.title).foregroundStyle(palette.ink).lineLimit(1)
                            Text(Date(timeIntervalSince1970: c.updatedAt / 1000).formatted(.relative(presentation: .named)))
                                .font(.caption).foregroundStyle(palette.inkFaint)
                        }
                    }
                }
            } header: { SectionHeader("Synced chats") } footer: {
                Text("Read-only copies, decrypted on this iPhone. They stay readable with no computer online.").foregroundStyle(palette.inkSoft)
            }
            Section {
                ForEach(cloud.devices.filter { !$0.revoked }) { d in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.label + (d.thisDevice ? " · this iPhone" : "")).foregroundStyle(palette.ink)
                            Text(d.fingerprint).font(.caption.monospaced()).foregroundStyle(palette.inkFaint)
                        }
                        Spacer()
                        if !d.trusted && !d.thisDevice && d.askedToJoin {
                            Button("Approve") { approving = d }.buttonStyle(.borderedProminent).controlSize(.small)
                        }
                    }
                }
            } header: { SectionHeader("Devices") } footer: {
                Text("Remove a device on a computer: Settings → Sync.").foregroundStyle(palette.inkSoft)
            }
            CloudMachinesSection()
        default:
            EmptyView()
        }
    }

    private func run(_ work: @escaping () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do { try await work(); error = nil } catch { self.error = (error as? CloudError)?.message ?? error.localizedDescription }
    }
}

/// Sign in to Nekko Cloud: Apple, GitHub or Google in a browser sheet, or an emailed code.
struct CloudSignInView: View {
    @Environment(CloudSync.self) private var cloud
    @Environment(\.palette) private var palette
    @Environment(\.webAuthenticationSession) private var webAuth
    @Environment(\.colorScheme) private var scheme
    @State private var email = ""
    @State private var code = ""
    @State private var sent = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var codeFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                CatMark().frame(width: 44, height: 44).foregroundStyle(palette.accent)
                    .padding(14).background(palette.accent.opacity(0.13), in: RoundedRectangle(cornerRadius: 18))
                VStack(spacing: 6) {
                    Text(sent ? "Check your email" : "Sign in to Nekko Cloud").font(.title2.weight(.semibold)).foregroundStyle(palette.ink)
                    Text(sent ? "We sent a 6-digit code to \(email)." : "Keep your chats on every device, end-to-end encrypted. Nekko Labs can't read them.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft).multilineTextAlignment(.center)
                }
                if sent {
                    TextField("123456", text: $code)
                        .textContentType(.oneTimeCode).keyboardType(.numberPad)
                        .font(.system(.title, design: .monospaced).weight(.semibold)).tracking(10)
                        .multilineTextAlignment(.center).padding(.vertical, 12)
                        .background(palette.surface, in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(codeFocused ? palette.accent : palette.line))
                        .focused($codeFocused).accessibilityLabel("Sign-in code").accessibilityIdentifier("cloud.code")
                        .onChange(of: code) { _, v in
                            code = String(v.filter(\.isNumber).prefix(6))
                            if code.count == 6 { Task { await verify() } }
                        }
                    Button { Task { await verify() } } label: { Text(busy ? "Signing in…" : "Sign in").frame(maxWidth: .infinity) }
                        .buttonStyle(PrismButtonStyle()).disabled(busy || code.count < 6)
                    Button("Use a different email") { sent = false; code = "" }.font(.footnote).foregroundStyle(palette.inkSoft)
                } else {
                    VStack(spacing: 10) {
                        ProviderButton(title: "Continue with Apple", symbol: "apple.logo") { await oauth("apple") }
                        ProviderButton(title: "Continue with GitHub", symbol: "chevron.left.forwardslash.chevron.right") { await oauth("github") }
                        ProviderButton(title: "Continue with Google", symbol: "g.circle") { await oauth("google") }
                    }
                    .disabled(busy)
                    HStack { Rectangle().fill(palette.line).frame(height: 1); Text("OR").font(.caption2).foregroundStyle(palette.inkFaint); Rectangle().fill(palette.line).frame(height: 1) }
                    TextField("you@example.com", text: $email)
                        .textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(12).background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line))
                        .accessibilityIdentifier("cloud.email")
                    Button { Task { await sendCode() } } label: { Text(busy ? "Sending…" : "Email me a sign-in code").frame(maxWidth: .infinity) }
                        .buttonStyle(PrismButtonStyle()).disabled(busy || !email.contains("@"))
                        .accessibilityIdentifier("cloud.sendCode")
                }
                if let error { Text(error).font(.footnote).foregroundStyle(palette.danger).multilineTextAlignment(.center) }
                Label("Your chats are encrypted on your devices before they're uploaded. Signing in only tells Nekko Cloud who you are.", systemImage: "lock")
                    .font(.footnote).foregroundStyle(palette.inkFaint).padding(.top, 6)
            }
            .padding(24)
            .background {
                RoundedRectangle(cornerRadius: 24).fill(.ultraThinMaterial)
                    .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(prism.opacity(0.6), lineWidth: 1))
                    .shadow(color: palette.accent.opacity(0.25), radius: 30, y: 16)
            }
            .padding(.horizontal, 18).padding(.vertical, 28)
        }
        .background(PrismLight().ignoresSafeArea())
    }

    private var prism: LinearGradient {
        LinearGradient(colors: [palette.accent, Color(hex: 0x06B6D4), Color(hex: 0x46E0BD), Color(hex: 0xFFBE5C), Color(hex: 0xFF7EB6)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    private func sendCode() async {
        busy = true; defer { busy = false }
        do { try await cloud.sendCode(email: email.trimmingCharacters(in: .whitespaces)); sent = true; error = nil; codeFocused = true } catch { self.error = msg(error) }
    }

    private func verify() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do { try await cloud.verifyCode(email: email.trimmingCharacters(in: .whitespaces), code: code); error = nil } catch { self.error = msg(error); code = "" }
    }

    private func oauth(_ provider: String) async {
        busy = true; defer { busy = false }
        do {
            let (url, verifier) = try await cloud.oauthStart(provider: provider)
            let callback = try await webAuth.authenticate(using: url, callbackURLScheme: "nekko-agent", preferredBrowserSession: .ephemeral)
            try await cloud.finishOAuth(callback: callback, verifier: verifier)
            error = nil
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            error = nil
        } catch {
            self.error = msg(error)
        }
    }

    private func msg(_ e: Error) -> String { (e as? CloudError)?.message ?? e.localizedDescription }
}

private struct ProviderButton: View {
    let title: String
    let symbol: String
    let action: () async -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button { Task { await action() } } label: {
            Label(title, systemImage: symbol).font(.body.weight(.medium)).frame(maxWidth: .infinity, minHeight: 44)
        }
        .foregroundStyle(palette.ink)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line))
    }
}

private struct PrismButtonStyle: ButtonStyle {
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold)).foregroundStyle(.white).frame(minHeight: 44)
            .background(LinearGradient(colors: [palette.accent, Color(hex: 0x06B6D4)], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 12))
            .opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
    }
}

/// The soft prism washes off the corners, as on the desktop's sign-in.
private struct PrismLight: View {
    @Environment(\.palette) private var palette
    var body: some View {
        ZStack {
            palette.paper
            RadialGradient(colors: [palette.accent.opacity(0.18), .clear], center: .bottomLeading, startRadius: 0, endRadius: 420)
            RadialGradient(colors: [Color(hex: 0x06B6D4).opacity(0.14), .clear], center: .topTrailing, startRadius: 0, endRadius: 380)
            RadialGradient(colors: [Color(hex: 0xFF7EB6).opacity(0.10), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 300)
        }
    }
}

/// This iPhone, the encrypted vault, the account's computers. While a sync
/// runs, sealed packets travel the arcs; at rest it is still (and with Reduce
/// Motion it is always still).
struct SyncPicture: View {
    let phase: CloudSync.Phase
    let others: Int
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let moving = phase == .syncing && !reduceMotion
        TimelineView(.animation(paused: !moving)) { tl in
            Canvas { ctx, size in draw(ctx, size, t: moving ? tl.date.timeIntervalSinceReferenceDate : 0, moving: moving) }
        }
        .opacity([.signedOut, .needsPlan, .notSetUp].contains(phase) ? 0.55 : 1)
    }

    private func draw(_ ctx: GraphicsContext, _ size: CGSize, t: Double, moving: Bool) {
        let mid = CGPoint(x: size.width / 2, y: size.height / 2)
        let left = CGPoint(x: mid.x - min(130, size.width * 0.33), y: mid.y)
        let n = max(1, min(3, others))
        let rights = (0..<n).map { i in CGPoint(x: mid.x + min(130, size.width * 0.33), y: mid.y + (CGFloat(i) - CGFloat(n - 1) / 2) * 44) }
        let prism = Gradient(colors: [palette.accent, Color(hex: 0x06B6D4), Color(hex: 0x46E0BD), Color(hex: 0xFFBE5C), Color(hex: 0xFF7EB6)])
        let dash = StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [3, 5])
        func arc(_ a: CGPoint, _ b: CGPoint) -> (Path, (Double) -> CGPoint) {
            let c = CGPoint(x: (a.x + b.x) / 2, y: min(a.y, b.y) - 34 + (b.y - mid.y) * 0.9)
            var p = Path(); p.move(to: a); p.addQuadCurve(to: b, control: c)
            return (p, { (t: Double) -> CGPoint in
                // The quadratic Bézier at t, in CGFloat steps (one long mixed expression times out the type checker).
                let u = CGFloat(t)
                let v: CGFloat = 1 - u
                let wa: CGFloat = v * v, wc: CGFloat = 2 * v * u, wb: CGFloat = u * u
                let x: CGFloat = wa * a.x + wc * c.x + wb * b.x
                let y: CGFloat = wa * a.y + wc * c.y + wb * b.y
                return CGPoint(x: x, y: y)
            })
        }
        var arcs = [arc(CGPoint(x: left.x + 22, y: left.y), CGPoint(x: mid.x - 26, y: mid.y))]
        arcs += rights.map { arc(CGPoint(x: mid.x + 26, y: mid.y), CGPoint(x: $0.x - 22, y: $0.y)) }
        for (p, _) in arcs { ctx.stroke(p, with: .color(moving ? palette.accent.opacity(0.45) : palette.line), style: dash) }

        // Glow behind the vault.
        let glow = Path(ellipseIn: CGRect(x: mid.x - 56, y: mid.y - 56, width: 112, height: 112))
        ctx.fill(glow, with: .radialGradient(Gradient(colors: [palette.accent.opacity(moving ? 0.32 + 0.12 * sin(t * 4) : 0.22), .clear]),
                                             center: mid, startRadius: 0, endRadius: 56))
        // Devices.
        func device(_ at: CGPoint, _ symbol: String, selfDevice: Bool) {
            let r = CGRect(x: at.x - 21, y: at.y - 21, width: 42, height: 42)
            ctx.fill(Path(ellipseIn: r), with: .color(palette.surface))
            ctx.stroke(Path(ellipseIn: r), with: .color(selfDevice ? palette.accent.opacity(0.7) : palette.line), lineWidth: 1.2)
            var g = ctx.resolve(Image(systemName: symbol))
            g.shading = .color(palette.inkSoft)
            ctx.draw(g, at: at)
        }
        device(left, "iphone", selfDevice: true)
        for (i, r) in rights.enumerated() { device(r, ["laptopcomputer", "desktopcomputer", "macmini"][i % 3], selfDevice: false) }
        // The vault: a shield with a lock.
        var shield = Path()
        shield.move(to: CGPoint(x: mid.x, y: mid.y - 34))
        shield.addLine(to: CGPoint(x: mid.x + 28, y: mid.y - 20))
        shield.addLine(to: CGPoint(x: mid.x + 28, y: mid.y + 8))
        shield.addQuadCurve(to: CGPoint(x: mid.x, y: mid.y + 38), control: CGPoint(x: mid.x + 26, y: mid.y + 30))
        shield.addQuadCurve(to: CGPoint(x: mid.x - 28, y: mid.y + 8), control: CGPoint(x: mid.x - 26, y: mid.y + 30))
        shield.addLine(to: CGPoint(x: mid.x - 28, y: mid.y - 20))
        shield.closeSubpath()
        ctx.fill(shield, with: .color(palette.surface))
        ctx.stroke(shield, with: .linearGradient(prism, startPoint: CGPoint(x: mid.x - 28, y: mid.y - 34), endPoint: CGPoint(x: mid.x + 28, y: mid.y + 38)), lineWidth: 2)
        let tone: Color = phase == .error ? palette.danger : (phase == .awaitingApproval || phase == .needsJoin) ? palette.warning : palette.accent
        var lock = ctx.resolve(Image(systemName: "lock.fill"))
        lock.shading = .color(tone)
        ctx.draw(lock, at: CGPoint(x: mid.x, y: mid.y + 2))
        if phase == .idle {
            var ok = ctx.resolve(Image(systemName: "checkmark.circle.fill"))
            ok.shading = .color(palette.success)
            ctx.draw(ok, at: CGPoint(x: mid.x + 22, y: mid.y + 30))
        }
        // Packets.
        guard moving else { return }
        for (i, (_, point)) in arcs.enumerated() {
            for k in 0..<2 {
                let u = (t / 1.6 + Double(k) * 0.5 + Double(i) * 0.17).truncatingRemainder(dividingBy: 1)
                let eased = u < 0.5 ? 2 * u * u : 1 - pow(-2 * u + 2, 2) / 2
                let p = point(eased)
                let rect = CGRect(x: p.x - 6, y: p.y - 4.5, width: 12, height: 9)
                ctx.fill(Path(roundedRect: rect, cornerRadius: 2.5), with: .linearGradient(prism, startPoint: rect.origin, endPoint: CGPoint(x: rect.maxX, y: rect.maxY)))
                ctx.fill(Path(roundedRect: rect.insetBy(dx: 3.8, dy: 3.2), cornerRadius: 0.8), with: .color(palette.surface.opacity(0.9)))
            }
        }
    }
}

/// A synced chat, read-only, decrypted on this iPhone.
struct SyncedChatView: View {
    let chatId: String
    @Environment(CloudSync.self) private var cloud
    @Environment(\.palette) private var palette

    var body: some View {
        let chat = cloud.chats.first { $0.id == chatId }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                Label("Synced copy · read only", systemImage: "lock.icloud").font(.caption).foregroundStyle(palette.inkFaint)
                ForEach(Array((chat?.messages ?? []).enumerated()), id: \.offset) { _, m in
                    if m.role == "user" {
                        Text(m.text).padding(10).foregroundStyle(palette.userInk)
                            .background(palette.userBubble, in: RoundedRectangle(cornerRadius: 14))
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    } else {
                        MarkdownText(text: m.text).foregroundStyle(palette.ink)
                    }
                }
            }
            .padding()
        }
        .background { AppBackdrop() }
        .navigationTitle(chat?.title ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The account's Nekko Cloud machines (decision 0017): sandboxed computers the
/// phone pairs with. Each opens its computer page; a new one is made and paired
/// in one step.
struct CloudMachinesSection: View {
    @Environment(CloudSync.self) private var cloud
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Section {
            if cloud.machines.isEmpty && loaded {
                Text("No machines yet.").foregroundStyle(palette.inkSoft)
            }
            ForEach(cloud.machines) { m in
                if let id = cloud.computerId(for: m), store.computers.contains(where: { $0.id == id }) {
                    NavigationLink(value: Route.computer(id)) { MachineRow(machine: m) }
                } else {
                    MachineRow(machine: m)
                }
            }
            Button { Task { await make() } } label: {
                if busy { ProgressView() } else { Label("New machine", systemImage: "plus") }
            }
            .disabled(busy || !(cloud.account?.canSync ?? false))
            .accessibilityIdentifier("cloud.newMachine")
            if let error { Text(error).font(.footnote).foregroundStyle(palette.danger) }
        } header: { SectionHeader("Machines") } footer: {
            Text("A sandboxed computer in the cloud, paired like any other. It sees only what you put in its scope: repositories by name, your own provider keys, Privacy Shield on. Nothing from your computers unless you copy it up. Pro and Team.")
                .foregroundStyle(palette.inkSoft)
        }
        .task { if !loaded { try? await cloud.loadMachines(); loaded = true } }
    }

    private func make() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let made = try await cloud.createMachine(name: "Nekko Cloud", region: "nrt", scope: CloudSync.MachineScope())
            let id = await store.pair(made.link)
            store.rename(id, to: made.machine.name)
            cloud.link(made.machine, computer: id)
        } catch { self.error = error.localizedDescription }
    }
}

struct MachineRow: View {
    let machine: CloudSync.Machine
    @Environment(\.palette) private var palette

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(machine.name).foregroundStyle(palette.ink)
                Text("\(machine.region.uppercased()) · \(machine.state) · \(machine.hoursUsed, format: .number.precision(.fractionLength(1))) of \(Int(machine.hoursIncluded)) h")
                    .font(.caption).foregroundStyle(palette.inkFaint)
            }
            Spacer()
            Circle().fill(machine.state == "running" ? palette.success : palette.inkFaint.opacity(0.5)).frame(width: 8, height: 8)
        }
        .accessibilityElement(children: .combine)
    }
}
