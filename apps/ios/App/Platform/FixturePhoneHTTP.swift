#if DEBUG
import Foundation
import NekkoKit

/// UI tests (`-uiTestPhoneProvider`): a Claude API provider that never leaves
/// the simulator. It lists one model and answers every prompt with the same
/// streamed reply, the way `fake-model.mjs` stands in for a computer's model.
struct FixturePhoneHTTP: PhoneHTTP {
    static let reply = "Hello from this iPhone."

    func send(_ request: PhoneRequest) async throws -> (status: Int, body: Data) {
        (200, Data(#"{"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5"},{"id":"claude-haiku-5-5","display_name":"Claude Haiku 5.5"}]}"#.utf8))
    }

    func lines(_ request: PhoneRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>) {
        let words = ["Hello ", "from ", "this ", "iPhone."]
        let stream = AsyncThrowingStream<String, Error> { c in
            let t = Task {
                for w in words {
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    c.yield(#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\#(w)"}}"#)
                }
                c.yield(#"data: {"type":"message_stop"}"#)
                c.finish()
            }
            c.onTermination = { _ in t.cancel() }
        }
        return (200, stream)
    }
}
#endif
