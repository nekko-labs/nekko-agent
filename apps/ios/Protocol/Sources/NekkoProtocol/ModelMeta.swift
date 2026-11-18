import Foundation

/// What a model picker row says on its right (#2925): a local model's parameters and size on
/// disk ("8B · 4.9 GB"), a cloud model's context window ("400K context"). Only what the provider
/// reported, never a guess, so nil when nothing is known.
public enum ModelMeta {
    public static func line(local: Bool, parameters: String? = nil, sizeBytes: Int64? = nil, contextLength: Int64? = nil) -> String? {
        if local {
            let parts = [parameters.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 },
                         sizeBytes.flatMap { $0 > 0 ? size($0) : nil }].compactMap { $0 }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
        guard let contextLength, contextLength > 0 else { return nil }
        return String(localized: "\(tokens(contextLength)) context")
    }

    /// 4.9 GB, 850 MB: decimal units, as the computer's model library shows them.
    public static func size(_ bytes: Int64) -> String {
        let gb = Double(bytes) / 1_000_000_000
        if gb >= 1 { return "\(oneDecimal(gb)) GB" }
        return "\(max(1, Int((Double(bytes) / 1_000_000).rounded()))) MB"
    }

    /// 400K, 1M, 1.5M, 512.
    public static func tokens(_ n: Int64) -> String {
        if n >= 1_000_000 { return "\(oneDecimal(Double(n) / 1_000_000))M" }
        if n >= 1_000 { return "\(Int((Double(n) / 1_000).rounded()))K" }
        return "\(n)"
    }

    private static func oneDecimal(_ v: Double) -> String {
        let r = (v * 10).rounded() / 10
        return r == r.rounded() ? "\(Int(r))" : String(format: "%.1f", r)
    }
}

/// Dated snapshots folded under the model they pin (#2925): `o3-2025-04-16` under `o3`,
/// `claude-sonnet-4-20250514` under `claude-sonnet-4`. Without the plain id in the list,
/// the newest snapshot leads its group.
public enum ModelSnapshots {
    public struct Fold: Equatable, Sendable, Identifiable {
        public let main: String
        /// Newest first.
        public let dated: [String]
        public var id: String { main }
    }

    /// The id without its date suffix, or nil when it has none.
    public static func base(_ id: String) -> String? {
        let parts = id.split(separator: "-", omittingEmptySubsequences: false)
        func digits(_ s: Substring, _ n: Int) -> Bool { s.count == n && s.allSatisfy(\.isASCII) && s.allSatisfy(\.isNumber) }
        if parts.count > 3, digits(parts[parts.count - 3], 4), digits(parts[parts.count - 2], 2), digits(parts[parts.count - 1], 2) {
            return parts.dropLast(3).joined(separator: "-")
        }
        if parts.count > 1, let last = parts.last, digits(last, 8), last.hasPrefix("20") {
            return parts.dropLast().joined(separator: "-")
        }
        return nil
    }

    /// Groups in the order their first member appears.
    public static func fold(_ ids: [String]) -> [Fold] {
        let present = Set(ids)
        var order: [String] = []
        var members: [String: [String]] = [:]
        for id in ids {
            let key = base(id).flatMap { $0.isEmpty ? nil : $0 } ?? id
            if members[key] == nil { order.append(key) }
            members[key, default: []].append(id)
        }
        return order.map { key in
            let group = members[key] ?? []
            let dated = group.filter { $0 != key }.sorted(by: >)
            if present.contains(key) { return Fold(main: key, dated: dated) }
            return Fold(main: dated.first ?? key, dated: Array(dated.dropFirst()))
        }
    }
}
