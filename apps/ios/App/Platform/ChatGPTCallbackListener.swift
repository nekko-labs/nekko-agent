import Foundation
import Network
import NekkoKit

/// Listens on this iPhone's loopback address, port 1455, for ChatGPT's sign-in
/// page to come back (#3244). OpenAI's sign-in only returns to
/// `http://localhost:1455/auth/callback`, so the app takes that one request while
/// the sign-in sheet is open. Loopback only: nothing on the network can reach it.
/// Anything other than the sign-in's own answer gets a 404 and the wait goes on.
/// All state lives on one serial queue.
final class ChatGPTCallbackListener: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "com.nekko.chatgpt-callback")
    private let expectedState: String
    private var started: CheckedContinuation<Void, Error>?
    private var waiter: CheckedContinuation<ChatGPTSignIn.Callback?, Never>?
    /// What came back before anyone waited for it.
    private var result: ChatGPTSignIn.Callback??
    private var finished = false

    init(state: String) throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        guard let port = NWEndpoint.Port(rawValue: ChatGPTSignIn.port),
              let listener = try? NWListener(using: params, on: port) else { throw ChatGPTSignIn.Problem.portBusy }
        self.listener = listener
        expectedState = state
    }

    /// Starts listening; throws `portBusy` when the port can't be held.
    func start() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            queue.async {
                self.started = c
                self.listener.stateUpdateHandler = { [weak self] state in self?.changed(state) }
                self.listener.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
                self.listener.start(queue: self.queue)
            }
        }
    }

    /// The sign-in's answer, or nil once stopped or after ten minutes.
    func wait() async -> ChatGPTSignIn.Callback? {
        await withCheckedContinuation { (c: CheckedContinuation<ChatGPTSignIn.Callback?, Never>) in
            queue.async {
                if let r = self.result { c.resume(returning: r); return }
                self.waiter = c
                self.queue.asyncAfter(deadline: .now() + 600) { self.deliver(nil) }
            }
        }
    }

    /// Stop listening; a wait under way ends with whatever came, or nil.
    func stop() { queue.async { self.deliver(nil) } }

    private func changed(_ state: NWListener.State) {
        switch state {
        case .ready:
            started?.resume(); started = nil
        case .failed, .cancelled:
            if let c = started { started = nil; c.resume(throwing: ChatGPTSignIn.Problem.portBusy) }
            deliver(nil)
        default:
            break
        }
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self else { conn.cancel(); return }
            let text = data.flatMap { String(data: $0, encoding: .isoLatin1) } ?? ""
            let line = text.components(separatedBy: "\r\n").first ?? ""
            let answer = ChatGPTSignIn.callback(requestLine: line, expectedState: self.expectedState)
            let reply: Data
            switch answer {
            case .ignored: reply = ChatGPTSignIn.notFound
            case .code: reply = ChatGPTSignIn.callbackResponse(ok: true)
            case .refused: reply = ChatGPTSignIn.callbackResponse(ok: false)
            }
            conn.send(content: reply, completion: .contentProcessed { _ in conn.cancel() })
            if answer != .ignored { self.deliver(answer) }
        }
    }

    /// On the queue: the first answer (or nil) wins; the listener then closes.
    private func deliver(_ answer: ChatGPTSignIn.Callback?) {
        guard !finished else { return }
        if answer == nil && result != nil { return }
        if let w = waiter {
            waiter = nil
            finished = true
            w.resume(returning: answer)
        } else {
            result = .some(answer)
            if answer == nil { finished = true }
        }
        listener.cancel()
    }
}
