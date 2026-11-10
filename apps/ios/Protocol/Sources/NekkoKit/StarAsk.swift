import Foundation

/// The in-chat "star us on GitHub" ask (spec/platform/github-star-ask.md):
/// shown at most twice, under the reply to the 10th and the 50th prompt sent
/// from this iPhone or iPad. A port of the rules in
/// `packages/shared/src/support.ts` (`STAR_ASK_AT`, `countStarAskPrompt`,
/// `starAskDue`, `markStarAskShown`, `stopStarAsk`); keep the two in step.
/// Kept on this device only (UserDefaults, `key`), never synced or sent.
public struct StarAsk: Equatable, Sendable {
    /// The prompt counts that carry the card: the same 10 and 50 as the desktop.
    public static let at = [10, 50]
    /// UserDefaults key, holding the JSON the desktop keeps in `localStorage`.
    public static let key = "starAsk"
    /// The repository the card opens: the phone has no GitHub connector star, so it is a link only.
    public static let repository = URL(string: "https://github.com/nekko-labs/nekko-agent")!

    /// Prompts sent here that got a finished reply.
    public var prompts: Int
    /// How many times the card has been shown.
    public var asked: Int
    /// Starred or "Don't ask again": never ask again.
    public var stopped: Bool

    public init(prompts: Int = 0, asked: Int = 0, stopped: Bool = false) {
        self.prompts = prompts
        self.asked = asked
        self.stopped = stopped
    }

    /// One that never asks (UI test runs that did not opt in).
    public static let never = StarAsk(stopped: true)

    /// Read a stored state (`parseStarAsk`): anything malformed counts as a fresh start.
    public static func parse(_ raw: String?) -> StarAsk {
        guard let data = raw?.data(using: .utf8), let stored = try? JSONDecoder().decode(Stored.self, from: data) else { return StarAsk() }
        func count(_ d: Double?) -> Int {
            guard let d, d.isFinite, d >= 0 else { return 0 }
            return d >= Double(Int.max) ? Int.max : Int(d.rounded(.down))
        }
        return StarAsk(prompts: count(stored.prompts), asked: count(stored.asked), stopped: stored.stopped == true)
    }

    /// The stored JSON, each field read on its own so one bad value doesn't lose the others.
    private struct Stored: Decodable {
        var prompts: Double?
        var asked: Double?
        var stopped: Bool?

        enum CodingKeys: String, CodingKey { case prompts, asked, stopped }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            prompts = try? c.decode(Double.self, forKey: .prompts)
            asked = try? c.decode(Double.self, forKey: .asked)
            stopped = try? c.decode(Bool.self, forKey: .stopped)
        }
    }

    /// The JSON stored under `key`, the same shape as the desktop's.
    public var encoded: String {
        stopped ? #"{"prompts":\#(prompts),"asked":\#(asked),"stopped":true}"# : #"{"prompts":\#(prompts),"asked":\#(asked)}"#
    }

    /// One more prompt got its reply (`countStarAskPrompt`).
    public func counted() -> StarAsk {
        var next = self
        next.prompts = prompts == Int.max ? prompts : prompts + 1
        return next
    }

    /// Whether the reply that just finished carries the card (`starAskDue`).
    public var due: Bool {
        guard !stopped, asked >= 0, asked < Self.at.count else { return false }
        return prompts >= Self.at[asked]
    }

    /// The card was shown (`markStarAskShown`): this ask is used up whatever happens
    /// next (ignoring it is "Not now"), and so is any later one whose count is
    /// already reached, so two asks never come back to back.
    public func shown() -> StarAsk {
        var next = self
        next.asked = max(asked + 1, Self.at.filter { prompts >= $0 }.count)
        return next
    }

    /// Starred or "Don't ask again" (`stopStarAsk`): never again.
    public func stop() -> StarAsk {
        var next = self
        next.stopped = true
        return next
    }

    /// A prompt sent here got its finished reply: the state to keep, and whether
    /// that reply carries the card (the desktop's `starAskAfterReply`).
    public func afterReply() -> (state: StarAsk, show: Bool) {
        let next = counted()
        return next.due ? (next.shown(), true) : (next, false)
    }
}
