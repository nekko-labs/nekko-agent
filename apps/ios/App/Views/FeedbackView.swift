import NekkoProtocol
import SwiftUI
import UIKit

/// *Send feedback* (#1004), from the computer menu and Settings → About: a
/// prompt to copy for your own coding agent, a quick note to Nekko Labs
/// through Nekko Cloud, or GitHub issues. The same three as the desktop and Android.
struct FeedbackSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var copied = false
    @State private var note = ""
    @State private var includeInfo = false
    @State private var sending = false
    @State private var sent = false
    @State private var error: String?

    var body: some View {
        let info = feedbackAppInfo
        let prompt = Feedback.agentPrompt(info)
        NavigationStack {
            Form {
                Section {
                    // What is copied, as it is copied: the agent reads English.
                    ScrollView {
                        Text(verbatim: prompt)
                            .font(.caption.monospaced()).foregroundStyle(palette.inkSoft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 140)
                    .accessibilityIdentifier("feedback.prompt")
                    Button {
                        UIPasteboard.general.string = prompt
                        copied = true
                        AccessibilityNotification.Announcement("Copied").post()
                        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
                    } label: {
                        Label(copied ? "Copied" : "Copy for an agent", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .accessibilityIdentifier("feedback.copy")
                } header: { SectionHeader("Copy for an agent") } footer: {
                    Text("Paste it into Claude Code, Codex or Nekko Agent on your computer. It asks what happened, checks for an existing issue, and files one only after you approve it.")
                        .foregroundStyle(palette.inkSoft)
                }
                Section {
                    if sent {
                        Label("Thanks. Your note is on its way to Nekko Labs.", systemImage: "checkmark.circle")
                            .foregroundStyle(palette.success)
                            .accessibilityIdentifier("feedback.sent")
                        Button("Write another") { sent = false }
                    } else {
                        TextField("What happened, or what would you like it to do?", text: $note, axis: .vertical)
                            .lineLimit(4...10)
                            .accessibilityIdentifier("feedback.note")
                        let length = Feedback.length(note)
                        if length >= Feedback.counterFrom {
                            Text(verbatim: "\(length) / \(Feedback.maxMessage)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(length > Feedback.maxMessage ? palette.danger : palette.inkSoft)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        Toggle(isOn: $includeInfo) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Include app info")
                                Text("App, version, OS and version, and CPU type. Nothing that identifies you.")
                                    .font(.caption).foregroundStyle(palette.inkSoft)
                            }
                        }
                        .accessibilityIdentifier("feedback.includeInfo")
                        Button {
                            guard let message = Feedback.message(note) else { return }
                            sending = true
                            error = nil
                            let sendInfo = includeInfo ? info : nil
                            Task {
                                let outcome = await app.sendFeedback(message, info: sendInfo)
                                sending = false
                                switch outcome {
                                case .sent:
                                    note = ""
                                    sent = true
                                case .rateLimited: error = String(localized: "Too many notes. Try again later.")
                                case .rejected: error = String(localized: "Nekko Cloud didn’t accept that note. Shorten it and try again.")
                                case .failed: error = String(localized: "Couldn’t send the note. Check your connection and try again.")
                                }
                            }
                        } label: {
                            HStack {
                                Label("Send", systemImage: "paperplane")
                                if sending { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(sending || Feedback.message(note) == nil)
                        .accessibilityIdentifier("feedback.send")
                        if let error {
                            Text(error).font(.footnote).foregroundStyle(palette.danger)
                                .accessibilityIdentifier("feedback.error")
                        }
                    }
                } header: { SectionHeader("Quick note") } footer: {
                    Text("Goes straight to Nekko Labs through Nekko Cloud, with no account. Leave out names, keys and chat contents.")
                        .foregroundStyle(palette.inkSoft)
                }
                Section {
                    Link(destination: Feedback.newIssueURL) {
                        Label("Open GitHub issues", systemImage: "arrow.up.right.square")
                    }
                    .accessibilityIdentifier("feedback.github")
                } header: { SectionHeader("GitHub") } footer: {
                    Text("Report a bug or suggest an idea in public, and follow what happens to it.")
                        .foregroundStyle(palette.inkSoft)
                }
            }
            .navigationTitle("Send feedback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .keyboardDoneButton()
        }
    }
}

/// What *Include app info* sends and the copied prompt names: the app, its
/// version, iOS or iPadOS and its version, and the CPU type. Never the device's
/// model, name, identifier or locale.
@MainActor private var feedbackAppInfo: Feedback.AppInfo {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    let os = UIDevice.current.userInterfaceIdiom == .pad ? "iPadOS" : "iOS"
    #if arch(arm64)
    let arch: String? = "arm64"
    #elseif arch(x86_64)
    let arch: String? = "x86_64"
    #else
    let arch: String? = nil
    #endif
    return Feedback.AppInfo(app: "ios", version: version, os: os, osVersion: UIDevice.current.systemVersion, arch: arch)
}
