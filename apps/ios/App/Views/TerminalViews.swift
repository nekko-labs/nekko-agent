import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit

/// A chat's terminals and the computer's SSH hosts (IO-33 FA-3, FA-6), as a
/// sheet from the chat's More menu. Opening one attaches this phone (Face ID
/// or the passcode, once per 5 minutes); typing then needs no more prompts.
struct TerminalsView: View {
    let chatId: String
    @Environment(\.dismiss) private var dismiss
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var model: TerminalsModel?
    @State private var active: TerminalSession?
    @State private var busy = false
    @State private var actionError: String?

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    list(model)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.paper)
            .navigationTitle("Terminals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(isPresented: Binding(get: { active != nil }, set: { if !$0 { active = nil } })) {
                if let active { TerminalScreenView(session: active) }
            }
            .task {
                if model == nil { model = TerminalsModel(sessionId: chatId, backend: store) }
                await model?.load()
            }
            .alert("Couldn’t open it", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(actionError ?? "") }
        }
    }

    private func list(_ model: TerminalsModel) -> some View {
        List {
            Section {
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
                } else if model.loaded && model.terminals.isEmpty {
                    Text("No terminals for this chat yet.").foregroundStyle(palette.inkSoft)
                }
                ForEach(model.terminals) { t in
                    Button { active = model.session(for: t) } label: { TerminalRow(terminal: t) }
                        .accessibilityIdentifier("terminals.row.\(t.id)")
                }
                Button {
                    open { try await model.newTerminal(cols: TerminalGrid.phone.cols, rows: TerminalGrid.phone.rows) }
                } label: { Label("New terminal", systemImage: "plus.rectangle.on.rectangle") }
                    .disabled(busy || store.conn != .online)
                    .accessibilityIdentifier("terminals.new")
            } header: {
                Text("This chat")
            } footer: {
                Text("A new terminal starts in the chat’s folder on \(store.computerName). The computer shows that this phone is attached.")
            }
            Section {
                if let e = model.hostsError {
                    Text(e).foregroundStyle(palette.inkSoft)
                } else if model.loaded && model.hosts.isEmpty {
                    Text("No hosts in ~/.ssh/config on \(store.computerName).").foregroundStyle(palette.inkSoft)
                }
                ForEach(model.hosts) { h in
                    Button {
                        open { try await model.openSsh(h, cols: TerminalGrid.phone.cols, rows: TerminalGrid.phone.rows) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.alias).foregroundStyle(palette.ink)
                            if let d = h.detail { Text(d).font(.caption).foregroundStyle(palette.inkSoft) }
                        }
                    }
                    .disabled(busy || store.conn != .online)
                    .accessibilityIdentifier("terminals.ssh.\(h.alias)")
                }
            } header: {
                Text("SSH")
            } footer: {
                Text("Runs ssh on \(store.computerName) with its own keys and config; nothing about the keys reaches this phone.")
            }
        }
        .pawRefreshable { await model.load() }
        .overlay { if busy { ProgressView() } }
    }

    private func open(_ make: @escaping () async throws -> TerminalSession) {
        busy = true
        Task {
            defer { busy = false }
            do { active = try await make() } catch { actionError = TerminalSession.describe(error, computer: store.computerName) }
        }
    }
}

private struct TerminalRow: View {
    let terminal: PhoneTerminal
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: terminal.kind == .ssh ? "network" : terminal.kind == .agent ? "list.bullet.rectangle" : "terminal")
                .foregroundStyle(terminal.running ? palette.accent : palette.inkFaint)
            VStack(alignment: .leading, spacing: 2) {
                Text(terminal.title.isEmpty ? terminal.shell : terminal.title).foregroundStyle(palette.ink).lineLimit(1)
                Text(terminal.detail).font(.caption).foregroundStyle(palette.inkSoft).lineLimit(1)
            }
            Spacer()
            if terminal.viewers > 0 {
                Image(systemName: "iphone").foregroundStyle(palette.inkSoft).accessibilityLabel("A phone is attached")
            }
        }
    }
}

/// The size of a character cell in the terminal's font.
enum TerminalGrid {
    static let fontSize: CGFloat = 12
    static let cell: CGSize = {
        let f = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        let w = ("M" as NSString).size(withAttributes: [.font: f]).width
        return CGSize(width: max(w, 1), height: max(f.lineHeight, 1))
    }()

    /// Columns and rows that fit `size` (with a small margin).
    static func fit(_ size: CGSize) -> (cols: Int, rows: Int) {
        (max(Int((size.width - 12) / cell.width), 10), max(Int(size.height / cell.height), 4))
    }

    /// A first guess for a new terminal before its screen is laid out (it
    /// follows the real size as soon as the screen appears).
    static let phone: (cols: Int, rows: Int) = (48, 24)
}

/// One terminal: live output with ANSI colours, the key row, and a buffered
/// command line for typing or dictating a whole line.
struct TerminalScreenView: View {
    let session: TerminalSession
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme
    @State private var line = ""
    @State private var ctrl = false
    @State private var size: CGSize = .zero
    @State private var confirmClose = false
    @FocusState private var lineFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            banner
            output
            if session.state == .live { controls }
        }
        .background(palette.paper)
        .navigationTitle(session.terminal.title.isEmpty ? "Terminal" : session.terminal.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { Task { await session.refresh() } } label: { Label("Read again", systemImage: "arrow.clockwise") }
                    if !session.terminal.readOnly {
                        Button(role: .destructive) { confirmClose = true } label: { Label("Close terminal", systemImage: "xmark.rectangle") }
                    }
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
        .confirmationDialog("Close this terminal on \(store.computerName)?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Close terminal", role: .destructive) { Task { try? await session.close() } }
        } message: {
            Text("Its shell stops, on the computer too.")
        }
        .task {
            if session.state == .opening { await session.start() }
        }
        .onDisappear { Task { await session.leave() } }
        .onChange(of: store.conn) { _, c in
            if c == .online { Task { await session.reconnected() } }
        }
    }

    @ViewBuilder private var banner: some View {
        switch session.state {
        case .opening:
            ProgressView("Opening…").padding()
        case .failed(let m):
            VStack(spacing: 8) {
                Label(m, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
                Button("Try again") { Task { await session.start() } }
            }
            .padding()
        case .exited(let code):
            note(code.map { "The shell exited (\($0))." } ?? "The shell exited.")
        case .closed:
            note("Closed.")
        case .readOnly:
            note("The agent’s commands: read only. Pull down or use Read again for more.")
        case .live:
            if let e = session.error { note(e, danger: true) }
        }
    }

    private func note(_ text: String, danger: Bool = false) -> some View {
        Text(text).font(.footnote).foregroundStyle(danger ? palette.danger : palette.inkSoft)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 6)
            .background(palette.surface)
    }

    private var output: some View {
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    let _ = session.version
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(session.screen.rendered(cursor: session.state == .live).enumerated()), id: \.offset) { _, l in
                            Text(attributed(l)).lineLimit(1).fixedSize(horizontal: true, vertical: false)
                                .frame(height: TerminalGrid.cell.height, alignment: .leading)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 6)
                    .textSelection(.enabled)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: session.version) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                .pawRefreshable { await session.refresh() }
            }
            .onAppear { size = geo.size }
            .onChange(of: geo.size) { _, s in size = s }
        }
        .background(terminalBackground)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.screen.screenText.filter { !$0.isEmpty }.suffix(8).joined(separator: "\n"))
        .accessibilityIdentifier("terminal.output")
        .task(id: size) {
            // Rotation, the keyboard, a split view: the terminal follows once the size settles.
            guard size != .zero else { return }
            try? await Task.sleep(nanoseconds: 250_000_000)
            let (c, r) = TerminalGrid.fit(size)
            session.resize(cols: c, rows: r)
        }
    }

    private var controls: some View {
        VStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    key("esc", "Escape") { session.key(.escape) }
                    key("tab", "Tab") { session.key(.tab) }
                    Button { ctrl.toggle() } label: {
                        keyFace(selected: ctrl) { Text("ctrl") }
                    }
                    .accessibilityLabel("Control")
                    .accessibilityAddTraits(ctrl ? .isSelected : [])
                    key("^C", "Control C") { session.key(.ctrl("c")) }
                    key("↑", "Up") { session.key(.up) }
                    key("↓", "Down") { session.key(.down) }
                    key("←", "Left") { session.key(.left) }
                    key("→", "Right") { session.key(.right) }
                    key("⌫", "Delete") { session.key(.backspace) }
                    key("⏎", "Return") { session.key(.enter) }
                    Button {
                        if let text = UIPasteboard.general.string { session.paste(text) }
                    } label: {
                        keyFace { Image(systemName: "doc.on.clipboard") }
                    }
                    .accessibilityLabel("Paste")
                }
                .padding(.horizontal, 10)
            }
            HStack(spacing: 8) {
                TextField(ctrl ? "Ctrl + a key" : "Type or dictate a command", text: $line)
                    .font(.system(.subheadline, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .focused($lineFocused)
                    .onSubmit { sendLine() }
                    .onChange(of: line) { _, v in
                        // With Ctrl on, the next key goes at once as Ctrl+key.
                        guard ctrl, let c = v.last else { return }
                        session.key(.ctrl(c))
                        line = ""
                        ctrl = false
                    }
                    .accessibilityIdentifier("terminal.line")
                Button { sendLine() } label: { Image(systemName: "return") }
                    .accessibilityLabel("Send the line")
                    .accessibilityIdentifier("terminal.send")
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func sendLine() {
        session.sendLine(line)
        line = ""
        lineFocused = true
    }

    /// A terminal key: its glyph on the key, its name for VoiceOver ("Up", not "up arrow").
    private func key(_ label: String, _ spoken: LocalizedStringKey, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { keyFace { Text(label) } }
            .accessibilityLabel(Text(spoken))
    }

    /// A key's look: text that follows Dynamic Type, and a 44 pt tall target
    /// around the drawn key, which stays compact.
    private func keyFace(selected: Bool = false, @ViewBuilder _ content: () -> some View) -> some View {
        content()
            .font(.system(.subheadline, design: .monospaced).weight(.medium))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(selected ? palette.accent : palette.surface2, in: RoundedRectangle(cornerRadius: 6))
            .foregroundStyle(selected ? palette.onAccent : palette.ink)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }

    // MARK: Colours

    private var dark: Bool { scheme == .dark }
    private var terminalBackground: Color { dark ? Color(hex: 0x0E0E14) : Color(hex: 0xFBFBFD) }
    private var terminalInk: Color { dark ? Color(hex: 0xE6E4EE) : Color(hex: 0x1C1B22) }

    private func attributed(_ l: TermLine) -> AttributedString {
        var out = AttributedString()
        for run in l.runs {
            var a = AttributedString(run.text)
            let s = run.style
            var fg = color(s.fg) ?? terminalInk
            var bg = color(s.bg)
            if s.inverse {
                let f = fg
                fg = bg ?? terminalBackground
                bg = f
            }
            a.foregroundColor = s.dim ? fg.opacity(0.6) : fg
            if let bg { a.backgroundColor = bg }
            var font = Font.system(size: TerminalGrid.fontSize, design: .monospaced)
            if s.bold { font = font.weight(.bold) }
            if s.italic { font = font.italic() }
            a.font = font
            if s.underline { a.underlineStyle = .single }
            if s.strike { a.strikethroughStyle = .single }
            out += a
        }
        if l.runs.isEmpty {
            var a = AttributedString(" ")
            a.font = .system(size: TerminalGrid.fontSize, design: .monospaced)
            out = a
        }
        return out
    }

    /// The 16 ANSI colours, readable on this screen's background in both themes.
    private var ansi: [Int] {
        dark
            ? [0x2E2E38, 0xFF6B6B, 0x5FD68A, 0xE8C05A, 0x6CA7FF, 0xC792EA, 0x56D4DD, 0xD6D4DF,
               0x6E6C7A, 0xFF8A8A, 0x7FE8A4, 0xF5D37A, 0x8DBBFF, 0xD8ACF2, 0x7FE3EA, 0xFFFFFF]
            : [0x1C1B22, 0xC22F2F, 0x1E7F45, 0x8A6400, 0x2457C5, 0x8A3FB3, 0x0F7C86, 0x6B6977,
               0x55535F, 0xD93C3C, 0x23924F, 0x9E7300, 0x2E66DB, 0x9C4CC7, 0x138C97, 0x2A2932]
    }

    private func color(_ c: TermColor) -> Color? {
        switch c {
        case .default:
            return nil
        case .rgb(let r, let g, let b):
            return Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
        case .palette(let n):
            let i = Int(n)
            if i < 16 { return Color(hex: ansi[i]) }
            if i < 232 {
                // The 6×6×6 cube.
                let v = i - 16
                let steps = [0, 95, 135, 175, 215, 255]
                return Color(.sRGB, red: Double(steps[v / 36]) / 255, green: Double(steps[(v / 6) % 6]) / 255, blue: Double(steps[v % 6]) / 255)
            }
            let grey = Double(8 + (i - 232) * 10) / 255
            return Color(.sRGB, red: grey, green: grey, blue: grey)
        }
    }
}
