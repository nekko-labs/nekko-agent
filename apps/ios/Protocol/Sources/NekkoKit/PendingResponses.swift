import Foundation
import NekkoProtocol
import Observation

/// A phone-local response, bound to the exact input the user saw.
public struct ResponseMessage: Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionId: String
    public let callId: String
    public let kind: String
    public let request: JSONValue
    public let payload: JSONValue
    public let text: String
    public var status: String = "waiting"
    public var error: String?

    public var pendingId: String { "\(kind):\(callId)" }
    public var unsent: Bool { status != "sent" }

    var json: JSONValue {
        var value: [String: JSONValue] = ["id": .string(id), "sessionId": .string(sessionId), "callId": .string(callId),
            "kind": .string(kind), "request": request, "payload": payload, "text": .string(text),
            "status": .string(status == "sending" ? "waiting" : status)]
        if let error { value["error"] = .string(error) }
        return .object(value)
    }

    static func from(_ value: JSONValue) -> ResponseMessage? {
        guard let id = value.str("id"), let session = value.str("sessionId"), let call = value.str("callId"),
              let kind = value.str("kind"), ["answer", "approval"].contains(kind),
              let request = value["request"], request.object != nil, let payload = value["payload"],
              let text = value.str("text"), let status = value.str("status"),
              ["waiting", "sending", "failed", "stale", "sent"].contains(status) else { return nil }
        return ResponseMessage(id: id, sessionId: session, callId: call, kind: kind, request: request,
                               payload: payload, text: text, status: status == "sending" ? "waiting" : status,
                               error: value.str("error"))
    }
}

/// One computer's durable response messages. No guarded policy changes or voice actions enter here.
/// A fresh pending read is required before every send; transport failures never authorize replay by themselves.
@MainActor
@Observable
public final class PendingResponses {
    static let file = "pending-responses"
    public private(set) var items: [ResponseMessage] = []
    private var computerId: String?
    private var generation = 0
    private var flushing = false
    private var flushRequested = false
    private let files: OfflineFiles?
    private let caller: () -> Caller?
    private let newId: () -> String

    public init(files: OfflineFiles?, caller: @escaping () -> Caller?,
                newId: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.files = files
        self.caller = caller
        self.newId = newId
    }

    public func load(_ computerId: String?) {
        generation += 1
        self.computerId = computerId
        items = computerId.flatMap { files?.load($0, Self.file)?.array }?.compactMap(ResponseMessage.from) ?? []
    }

    public func messages(for sessionId: String) -> [ResponseMessage] { items.filter { $0.sessionId == sessionId } }

    public func contains(_ sessionId: String, question: AskRequest) -> Bool {
        items.contains { $0.sessionId == sessionId && $0.kind == "answer" && $0.request == Self.request(question) }
    }

    public func contains(_ sessionId: String, approval: Approval) -> Bool {
        items.contains { $0.sessionId == sessionId && $0.kind == "approval" && $0.request == Self.request(approval) }
    }

    public func answer(_ sessionId: String, question: AskRequest, answers: [AskAnswer]) {
        let text = answers.map { answer in
            ([question.questions.first(where: { $0.id == answer.questionId })?.header].compactMap { $0 }.filter { !$0.isEmpty }
             + [((answer.labels + [answer.note].compactMap { $0 }.filter { !$0.isEmpty }).joined(separator: ", "))])
                .joined(separator: ": ")
        }.joined(separator: "\n")
        enqueue(sessionId, callId: question.callId, kind: "answer", request: Self.request(question),
                payload: .array(answers.map(\.json)), text: text)
    }

    public func approve(_ sessionId: String, approval: Approval, ok: Bool) {
        enqueue(sessionId, callId: approval.call.id, kind: "approval", request: Self.request(approval),
                payload: .bool(ok), text: "\(ok ? "Allow" : "Deny") \(approval.call.name)")
    }

    private func enqueue(_ sessionId: String, callId: String, kind: String, request: JSONValue, payload: JSONValue, text: String) {
        guard computerId != nil,
              !items.contains(where: { $0.sessionId == sessionId && $0.kind == kind && $0.request == request }) else { return }
        items.append(ResponseMessage(id: newId(), sessionId: sessionId, callId: callId, kind: kind,
                                     request: request, payload: payload, text: text))
        save()
    }

    /// An in-flight request cannot be recalled; cancellation is available until dispatch begins.
    public func cancel(_ id: String) {
        items.removeAll { $0.id == id && $0.unsent && $0.status != "sending" }
        save()
    }

    public func retry(_ id: String) {
        guard let index = items.firstIndex(where: { $0.id == id && $0.unsent && $0.status != "sending" }) else { return }
        items[index].status = "waiting"
        items[index].error = nil
        save()
        Task { await flush() }
    }

    public func flush() async {
        guard !flushing else { flushRequested = true; return }
        flushing = true
        let epoch = generation
        defer {
            flushing = false
            if flushRequested || epoch != generation {
                flushRequested = false
                Task { await flush() }
            }
        }
        guard let connection = caller() else { return }
        for message in items.filter({ $0.unsent && $0.status != "stale" }) {
            guard generation == epoch, caller() === connection else { return }
            guard items.contains(where: { $0.id == message.id && $0.unsent }) else { continue }
            update(message.id, status: "sending")
            do {
                let raw = try await connection.call(Channels.chatPending)
                guard generation == epoch else { return }
                guard caller() === connection else { update(message.id, status: "waiting"); return }
                guard raw.object != nil else { throw RelayError("Could not verify the original request.") }
                let pending = PendingInput.map(raw)[message.sessionId]
                let current = message.kind == "answer" ? pending?.question.map(Self.request) : pending?.approval.map(Self.request)
                guard current == message.request else {
                    update(message.id, status: "stale", error: "The original request is no longer pending.")
                    continue
                }
                _ = try await connection.call(message.kind == "answer" ? Channels.chatAnswer : Channels.toolApprove,
                    [.string(message.sessionId), .string(message.callId), message.payload])
                guard generation == epoch else { return }
                update(message.id, status: "sent")
            } catch {
                guard generation == epoch else { return }
                update(message.id, status: "failed", error: error.localizedDescription)
            }
        }
    }

    private func update(_ id: String, status: String, error: String? = nil) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].status = status
        items[index].error = error
        save()
    }

    private func save() {
        if let computerId { files?.save(computerId, Self.file, .array(items.map(\.json))) }
    }

    static func request(_ question: AskRequest) -> JSONValue {
        ["callId": .string(question.callId), "askedAt": .int(question.askedAt),
         "questions": .array(question.questions.map { q in
             ["id": .string(q.id), "header": .string(q.header), "question": .string(q.question), "multiSelect": .bool(q.multiSelect),
              "options": .array(q.options.map { ["label": .string($0.label), "description": $0.description.map(JSONValue.string) ?? .null] })]
         })]
    }

    static func request(_ approval: Approval) -> JSONValue {
        ["callId": .string(approval.call.id), "name": .string(approval.call.name), "input": approval.call.input,
         "reason": .string(approval.reason), "severity": .string(approval.severity.rawValue)]
    }
}
