import Foundation

/// What a paid cloud clip's question says about the clip (#3038): the model, the
/// service that bills it, whether the first picture leaves the computer, and the
/// price of every combination, keyed `length|audio|resolution` (an absent
/// question is an empty label).
public struct ClipOffer: Equatable, Sendable {
    public let model: String
    public let via: String
    public let sendsPicture: Bool
    public let prices: [String: Double]

    public init(model: String, via: String, sendsPicture: Bool, prices: [String: Double]) {
        self.model = model
        self.via = via
        self.sendsPicture = sendsPicture
        self.prices = prices
    }

    /// Nil unless the field names a model and the service that bills it.
    public static func from(_ v: JSONValue?) -> ClipOffer? {
        guard let v, v.object != nil, let model = v.str("model"), !model.isEmpty, let via = v.str("via"), !via.isEmpty else { return nil }
        var prices: [String: Double] = [:]
        for (key, value) in v["prices"]?.object ?? [:] {
            if let n = value.double, n.isFinite, n >= 0 { prices[key] = n }
        }
        return ClipOffer(model: model, via: via, sendsPicture: v.flag("sendsPicture"), prices: prices)
    }
}

/// The paid clip picker's choices, total and answers: a port of the desktop's
/// `ClipPicker.tsx`, so both phones and the desktop confirm the same number.
public enum ClipPicker {
    /// The questions the price table is keyed by, in key order.
    public static let headers = ["Length", "Audio", "Resolution"]
    public static let warning = "Once started it cannot be stopped, and it is charged even if you stop the chat."

    /// The first option of each question: the daemon puts the suggested one first.
    public static func suggested(_ request: AskRequest) -> [String: String] {
        Dictionary(uniqueKeysWithValues: request.questions.map { ($0.id, $0.options.first?.label ?? "") })
    }

    /// The total for these picks, from the price table; nil when it holds no such combination.
    public static func total(_ request: AskRequest, picks: [String: String]) -> Double? {
        guard let offer = request.clip else { return nil }
        let key = headers.map { header in
            request.questions.first { $0.header == header }.map { picks[$0.id] ?? "" } ?? ""
        }.joined(separator: "|")
        return offer.prices[key]
    }

    /// Two decimals, as the daemon compares them (`"2.40"`), with no locale.
    public static func amount(_ total: Double) -> String { String(format: "%.2f", locale: nil, total) }
    public static func dollars(_ total: Double) -> String { "$" + amount(total) }

    /// The answers the daemon reads: each question's pick, then the confirmed total.
    public static func answers(_ request: AskRequest, picks: [String: String], total: Double) -> [AskAnswer] {
        request.questions.map { AskAnswer(questionId: $0.id, labels: [picks[$0.id] ?? ""]) }
            + [AskAnswer(questionId: "total", labels: [amount(total)])]
    }

    /// Where the prompt goes, said before paying.
    public static func leaves(_ offer: ClipOffer) -> String {
        "\(offer.sendsPicture ? "The prompt and the first picture leave" : "The prompt leaves") this computer for \(offer.via) and the model’s provider."
    }

    /// The button that starts the clip and names what it costs.
    public static func makeTitle(total: Double?, sending: Bool) -> String {
        if sending { return "Starting…" }
        return total.map { "Make clip · \(dollars($0))" } ?? "Make clip"
    }
}
