import CarPlay
import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit

/// The car's screen (Info.plist's CarPlay scene, routed by `AppDelegate`). Nekko is a
/// CarPlay voice-based conversational app: it opens listening, lists the work on every
/// computer, and keeps a Results list of what the driver's commands did. The rules live
/// in `CarSession` (NekkoKit); this draws them with CarPlay's templates.
/// Design: nekko-designs/carplay-design.html. Spec: spec/phone/carplay.md.
final class CarPlaySceneDelegate: UIResponder, @preconcurrency CPTemplateApplicationSceneDelegate {
    static let configurationName = "CarPlay"
    private var screens: CarScreens?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        let screens = CarScreens(interface: interfaceController, model: AppModel.shared)
        self.screens = screens
        screens.connect()
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        screens?.disconnect()
        screens = nil
    }
}

/// The templates, at most three deep (Apple's limit for this category): a tab bar of
/// Work and Results, a chat's information pushed from Work, and the voice sheet,
/// alerts and action sheets presented over them.
@MainActor
final class CarScreens {
    private let interface: CPInterfaceController
    private let model: AppModel
    private var car: CarSession { model.car }
    private let work = CPListTemplate(title: String(localized: "Nekko"), sections: [])
    private let results = CPListTemplate(title: String(localized: "Results"), sections: [])
    private var voice: CPVoiceControlTemplate?
    private var talking: Task<Void, Never>?
    private var watching: Task<Void, Never>?
    private let speaker = ConversationSpeaker()
    /// The chat whose information is on screen, and its template, updated in place.
    private var open: (id: String, template: CPInformationTemplate)?
    /// What was drawn last, so an unchanged list is not redrawn every tick.
    private var drawn: (chats: [CarChat], results: [CarResult], online: Bool)?
    /// The microphone was refused while listening: said once the sheet is gone.
    private var micRefused = false

    init(interface: CPInterfaceController, model: AppModel) {
        self.interface = interface
        self.model = model
    }

    func connect() {
        model.carConnected()
        work.tabTitle = String(localized: "Work")
        work.tabImage = UIImage(systemName: "bolt.horizontal.circle")
        work.emptyViewTitleVariants = [String(localized: "All quiet")]
        work.emptyViewSubtitleVariants = [String(localized: "Nothing is running.")]
        results.tabTitle = String(localized: "Results")
        results.tabImage = UIImage(systemName: "checklist")
        results.emptyViewTitleVariants = [String(localized: "No commands yet")]
        results.emptyViewSubtitleVariants = [String(localized: "Tap Talk and say what's happening.")]
        work.trailingNavigationBarButtons = [talkButton()]
        results.trailingNavigationBarButtons = [talkButton()]
        let tabs = CPTabBarTemplate(templates: [work, results])
        interface.setRootTemplate(tabs, animated: false, completion: nil)
        redraw()
        watch()
        // Voice is the primary mode on launch (CarPlay Developer Guide): open listening,
        // unless there is nothing to talk to.
        if model.store.computers.isEmpty {
            alert(String(localized: "No computer paired"),
                  String(localized: "Nekko Agent shows your agents here once a computer is paired."))
        } else {
            talk(inChat: nil)
        }
    }

    func disconnect() {
        watching?.cancel()
        watching = nil
        cancelTalk()
        model.carDisconnected()
    }

    private func talkButton() -> CPBarButton {
        CPBarButton(title: String(localized: "Talk")) { [weak self] _ in MainActor.assumeIsolated { self?.talk(inChat: nil) } }
    }

    // MARK: Keeping the lists current

    /// The chats change through events, the store and the card's runs; a short tick
    /// rebuilds the lists only when what they show changed.
    private func watch() {
        watching = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.car.refresh()
                self?.redraw()
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

    private func redraw() {
        let chats = model.carChats()
        let online = model.store.conn == .online
        let now = (chats: chats, results: car.results, online: online)
        if let drawn, drawn.chats == now.chats, drawn.results == now.results, drawn.online == now.online { return }
        drawn = now
        work.updateSections(workSections(chats, online: online))
        results.updateSections([CPListSection(items: car.results.prefix(limit).map { resultItem($0) as CPListTemplateItem })])
        if let open {
            if let chat = chats.first(where: { $0.id == open.id }) { fill(open.template, chat) }
        }
    }

    private var limit: Int { max(1, Int(CPListTemplate.maximumItemCount)) }

    private func workSections(_ chats: [CarChat], online: Bool) -> [CPListSection] {
        var left = limit
        var sections: [CPListSection] = []
        let groups: [(LiveChatState, String)] = [(.needsYou, String(localized: "Needs you")), (.working, String(localized: "Working")),
                                                 (.watching, String(localized: "Watching")), (.failed, String(localized: "Stopped")),
                                                 (.done, String(localized: "Done"))]
        for (state, header) in groups {
            let rows = chats.filter { $0.state == state }.prefix(left)
            guard !rows.isEmpty else { continue }
            left -= rows.count
            // Offline, the first header says the list is the last one the phone heard.
            let title = sections.isEmpty && !online ? offlineHeader() : header
            sections.append(CPListSection(items: rows.map { workItem($0) as CPListTemplateItem }, header: title, sectionIndexTitle: nil))
        }
        return sections
    }

    private func offlineHeader() -> String {
        let name = model.store.active?.name ?? String(localized: "Your computer")
        return String(localized: "\(name) is offline · last known")
    }

    private func workItem(_ c: CarChat) -> CPListItem {
        var detail = c.state == .needsYou && c.step.isEmpty ? c.state.word : (c.step.isEmpty ? c.state.word : c.step)
        if let started = c.startedAt, c.state == .working || c.state == .needsYou {
            detail += " · " + Self.elapsed(since: started)
        }
        if !c.actionable { detail += " · " + c.computerName }
        let item = CPListItem(text: c.title, detailText: detail, image: CarGlyphs.state(c.state))
        item.accessoryType = .disclosureIndicator
        item.handler = { [weak self] _, done in
            MainActor.assumeIsolated { self?.show(c.id) }
            done()
        }
        return item
    }

    private func resultItem(_ r: CarResult) -> CPListItem {
        let item = CPListItem(text: r.title, detailText: "\(r.detail) · \(r.at.formatted(date: .omitted, time: .shortened))",
                              image: CarGlyphs.outcome(r.outcome))
        item.handler = { [weak self] _, done in
            MainActor.assumeIsolated {
                if let self, let text = self.car.speech(for: r.id) { self.say(text) }
            }
            done()
        }
        return item
    }

    static func elapsed(since start: Date, now: Date = Date()) -> String {
        let minutes = max(0, Int(now.timeIntervalSince(start) / 60))
        if minutes < 1 { return String(localized: "just now") }
        if minutes < 60 { return String(localized: "\(minutes) min") }
        return String(localized: "\(minutes / 60) h \(minutes % 60) min")
    }

    // MARK: A chat

    private func show(_ chatId: String) {
        guard let chat = model.carChats().first(where: { $0.id == chatId }) else { return }
        let template = CPInformationTemplate(title: chat.title, layout: .leading, items: [], actions: [])
        fill(template, chat)
        open = (chatId, template)
        interface.pushTemplate(template, animated: true, completion: nil)
    }

    /// State facts only, never what the agent wrote, and only the buttons that apply now.
    private func fill(_ t: CPInformationTemplate, _ c: CarChat) {
        var items = [CPInformationItem(title: String(localized: "Status"), detail: c.state.word)]
        if !c.step.isEmpty { items.append(CPInformationItem(title: c.callId != nil ? String(localized: "Waiting on") : String(localized: "Step"), detail: c.step)) }
        if c.callId != nil, let severity = c.severity { items.append(CPInformationItem(title: String(localized: "Risk"), detail: severity.capitalized)) }
        items.append(CPInformationItem(title: String(localized: "Computer"), detail: c.computerName))
        if let started = c.startedAt, c.state == .working || c.state == .needsYou {
            items.append(CPInformationItem(title: String(localized: "Running for"), detail: Self.elapsed(since: started)))
        }
        t.items = items

        var actions: [CPTextButton] = []
        if c.actionable, c.state == .needsYou, c.callId != nil {
            actions.append(CPTextButton(title: String(localized: "Allow"), textStyle: .confirm) { [weak self] _ in MainActor.assumeIsolated { self?.touch(.allow(chat: nil), c.id) } })
            actions.append(CPTextButton(title: String(localized: "Deny"), textStyle: .normal) { [weak self] _ in MainActor.assumeIsolated { self?.touch(.deny(chat: nil), c.id) } })
        }
        if c.actionable, c.state != .watching {
            actions.append(CPTextButton(title: String(localized: "Talk"), textStyle: actions.isEmpty ? .confirm : .normal) { [weak self] _ in MainActor.assumeIsolated { self?.talk(inChat: c.id) } })
        }
        if actions.count < 3, !c.reply.isEmpty {
            actions.append(CPTextButton(title: String(localized: "Hear latest"), textStyle: .normal) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.say(await self.car.handle("read it", inChat: c.id).speech)
                }
            })
        }
        if actions.count < 3, c.actionable, c.state == .working {
            actions.append(CPTextButton(title: String(localized: "Stop"), textStyle: .cancel) { [weak self] _ in MainActor.assumeIsolated { self?.confirmStop(c) } })
        }
        t.actions = Array(actions.prefix(3))
    }

    /// A tap on Allow or Deny: the tap is the driver's own confirmation, so the read-back
    /// is answered at once. The rules (unlocked to allow, not high risk) still apply.
    private func touch(_ command: CarCommand, _ chatId: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let before = self.car.results.first?.id
            let reply = await self.car.act(command, on: chatId)
            self.redraw()
            if self.car.results.first?.id == before || self.car.results.first?.outcome == .failed {
                self.alert(String(localized: "Not done"), reply.speech)
            }
        }
    }

    private func confirmStop(_ c: CarChat) {
        let sheet = CPActionSheetTemplate(
            title: String(localized: "Stop \(c.title)?"), message: String(localized: "Its work so far stays in the chat."),
            actions: [
                CPAlertAction(title: String(localized: "Stop"), style: .destructive) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.interface.dismissTemplate(animated: true, completion: nil)
                        self?.touch(.stop(chat: nil), c.id)
                    }
                },
                CPAlertAction(title: String(localized: "Cancel"), style: .cancel) { [weak self] _ in
                    MainActor.assumeIsolated { self?.interface.dismissTemplate(animated: true, completion: nil) }
                },
            ])
        interface.presentTemplate(sheet, animated: true, completion: nil)
    }

    private func alert(_ title: String, _ message: String) {
        let alert = CPAlertTemplate(titleVariants: [title, message].filter { !$0.isEmpty }, actions: [
            CPAlertAction(title: String(localized: "OK"), style: .default) { [weak self] _ in
                MainActor.assumeIsolated { self?.interface.dismissTemplate(animated: true, completion: nil) }
            },
        ])
        interface.presentTemplate(alert, animated: true, completion: nil)
    }

    // MARK: Voice

    /// The voice sheet's states. The confirm states name the verb only; what will be
    /// sent is said, never drawn (Apple: no text in response to queries).
    private static let states: [(String, String, String)] = [
        (CarVoicePhase.listening.rawValue, String(localized: "Listening…"), "waveform"),
        (CarVoicePhase.working.rawValue, String(localized: "Working on it…"), "ellipsis"),
        (CarVoicePhase.speaking.rawValue, String(localized: "Nekko"), "speaker.wave.2"),
        ("confirm-send", String(localized: "Say yes to send"), "mic"),
        ("confirm-start", String(localized: "Say yes to start"), "mic"),
        ("confirm-allow", String(localized: "Say yes to allow"), "mic"),
        ("confirm-deny", String(localized: "Say yes to deny"), "mic"),
        ("confirm-stop", String(localized: "Say yes to stop"), "mic"),
    ]

    private func makeVoice() -> CPVoiceControlTemplate {
        let states = Self.states.map { id, title, symbol in
            let state = CPVoiceControlState(identifier: id, titleVariants: [title], image: UIImage(systemName: symbol), repeats: true)
            if #available(iOS 26.4, *) {
                let cancel = CPButton(image: UIImage(systemName: "xmark") ?? UIImage()) { [weak self] _ in MainActor.assumeIsolated { self?.cancelTalk() } }
                cancel.title = String(localized: "Cancel")
                var buttons = [cancel]
                if id == CarVoicePhase.listening.rawValue {
                    let done = CPButton(image: UIImage(systemName: "checkmark") ?? UIImage()) { [weak self] _ in MainActor.assumeIsolated { self?.model.carDictation.stopListening() } }
                    done.title = String(localized: "Done")
                    buttons.append(done)
                }
                state.actionButtons = Array(buttons.prefix(CPVoiceControlState.maximumActionButtonCount))
            }
            return state
        }
        return CPVoiceControlTemplate(voiceControlStates: states)
    }

    private func phase(_ p: CarVoicePhase) {
        guard let voice, p != .done else { return }
        let id = p == .confirming ? "confirm-\((car.confirming ?? .send).rawValue)" : p.rawValue
        voice.activateVoiceControlState(withIdentifier: id)
    }

    /// Opens the voice sheet and runs one exchange (`CarSession.talk`). The microphone
    /// and the audio session are open only while the sheet is up.
    private func talk(inChat chatId: String?) {
        guard talking == nil else { return }
        let voice = makeVoice()
        self.voice = voice
        micRefused = false
        interface.presentTemplate(voice, animated: true, completion: nil)
        talking = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.car.talk(
                inChat: chatId,
                capture: { [weak self] in
                    guard let self else { throw CancellationError() }
                    do { return try await self.model.carCapture() } catch let e as DictationError where e == .needsPermission {
                        self.micRefused = true
                        throw CancellationError()
                    }
                },
                speak: { [weak self] text in try await self?.speaker.speak(text) },
                phase: { [weak self] p in self?.phase(p) },
                awaitReply: { [weak self] id, before in try await self?.model.carAwaitReply(id, before: before) })
            self.finishTalk()
        }
    }

    private func finishTalk() {
        talking = nil
        if voice != nil {
            voice = nil
            interface.dismissTemplate(animated: true, completion: nil)
        }
        redraw()
        if micRefused {
            micRefused = false
            alert(String(localized: "Microphone is off"), String(localized: "Microphone access for Nekko Agent is turned off."))
        }
    }

    /// The sheet's Cancel: stop listening and speaking now; nothing more is sent.
    private func cancelTalk() {
        talking?.cancel()
        model.carDictation.discard()
        speaker.stop()
    }

    /// Speak one line with the voice sheet up (Apple: voice features show it).
    private func say(_ text: String) {
        guard talking == nil else { return }
        let voice = makeVoice()
        self.voice = voice
        interface.presentTemplate(voice, animated: true, completion: nil)
        voice.activateVoiceControlState(withIdentifier: CarVoicePhase.speaking.rawValue)
        talking = Task { @MainActor [weak self] in
            try? await self?.speaker.speak(text)
            self?.finishTalk()
        }
    }
}

/// Our status glyphs as the images CarPlay's rows take, drawn once per state.
@MainActor
enum CarGlyphs {
    private static var cache: [String: UIImage] = [:]

    static func state(_ state: LiveChatState) -> UIImage? {
        image("state-\(state.rawValue)") { AnyView(LiveStatusGlyph(state: state, size: 22)) }
    }

    static func outcome(_ outcome: CarResult.Outcome) -> UIImage? {
        switch outcome {
        case .done: return state(.done)
        case .failed: return state(.failed)
        case .info: return image("info") { AnyView(LiveStatusGlyph(state: .done, size: 22, ink: BrandColor.inkFaintOnDark)) }
        case .waiting:
            return image("waiting") {
                AnyView(ClockGlyph().stroke(BrandColor.inkFaintOnDark, style: StrokeStyle(lineWidth: 22 / 9, lineCap: .round, lineJoin: .round))
                    .frame(width: 22, height: 22))
            }
        }
    }

    private static func image(_ key: String, _ view: () -> AnyView) -> UIImage? {
        if let hit = cache[key] { return hit }
        let renderer = ImageRenderer(content: view().padding(1))
        renderer.scale = 3
        let made = renderer.uiImage
        cache[key] = made
        return made
    }
}
