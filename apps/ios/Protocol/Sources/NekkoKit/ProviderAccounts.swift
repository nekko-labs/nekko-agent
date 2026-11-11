import Foundation
import NekkoProtocol

/// How a computer's provider reads in the model pickers, with the desktop's wording
/// (providerAccounts.ts, #2488). One Claude login can hold a personal plan and an
/// organization seat; each is its own Claude subscription provider, so each names
/// itself from its `account`: "Personal · Max" over "philip@example.test · Personal plan",
/// "Nekko Labs · Team" over "philip@example.test · Organization".
/// Every other provider keeps its saved label.
extension PublicProvider {
    /// The account behind it when it names itself: signed in with an email (a plan login).
    /// An API-key login (signed in, no email) and a signed-out one keep the saved label.
    var planAccount: ProviderAccount? {
        guard let account, account.signedIn, account.email != nil else { return nil }
        return account
    }

    /// "Personal", or the organization's name.
    private func accountName(_ account: ProviderAccount) -> String {
        if let name = account.name { return name }
        return account.scope == .organization ? String(localized: "Organization") : String(localized: "Personal")
    }

    /// The picker's group title: "{name} · {Plan}" ("Personal · Max", "Nekko Labs · Team"),
    /// just the name with no plan, else the saved label.
    public var accountTitle: String {
        guard let account = planAccount else { return label }
        let name = accountName(account)
        guard let plan = account.plan else { return name }
        return "\(name) · \(plan.prefix(1).uppercased() + plan.dropFirst())"
    }

    /// Whether `accountTitle` already says the plan, so the limits under it need not say it again.
    public var titleNamesPlan: Bool { planAccount?.plan != nil }

    /// The fainter line under the title: "{email} · Personal plan", "{email} · Organization",
    /// "Signed out" for a login that signed out; nil when there is nothing to add.
    public var accountCaption: String? {
        guard let account else { return nil }
        if !account.signedIn { return String(localized: "Signed out") }
        guard let email = account.email else { return nil }
        switch account.scope {
        case .personal: return "\(email) · \(String(localized: "Personal plan"))"
        case .organization: return "\(email) · \(String(localized: "Organization"))"
        case nil: return email
        }
    }

    /// The provider's name beside a model (chips, starred rows): "Claude · Nekko Labs"
    /// for a plan login, so two accounts on one email read apart; else the saved label.
    public var shortName: String {
        guard let account = planAccount else { return label }
        return "Claude · \(accountName(account))"
    }

    /// Whether a picker search names this provider's account (its email or name).
    public func accountMatches(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let account = planAccount else { return false }
        return [account.email, account.name].contains { $0?.localizedCaseInsensitiveContains(q) == true }
    }
}

extension PublicProvider {
    /// A Claude subscription login. A computer's logins share one "Claude" group with a tab per account.
    public var isClaudeLogin: Bool { kind == "claude-code" }

    /// The line under the account slider for the account on show: its email and which account it is.
    /// Nil for a signed-out login (its tab already says so) or one without an email.
    public var accountWhoLine: String? { account?.signedIn == true ? accountCaption : nil }

    /// Each login's tab in the account slider: `accountTitle` ("Personal · Max"), a signed-out
    /// login's label with "Signed out" after it, and the email for two accounts that would
    /// otherwise read the same (as the desktop's `disambiguate`).
    public static func accountTabLabels(_ providers: [PublicProvider]) -> [String: String] {
        let raw = Dictionary(uniqueKeysWithValues: providers.map { p in
            (p.id, p.account?.signedIn == false ? "\(p.label) · \(String(localized: "Signed out"))" : p.accountTitle)
        })
        return Dictionary(uniqueKeysWithValues: providers.map { p in
            let mine = raw[p.id] ?? p.label
            let clash = providers.contains { $0.id != p.id && raw[$0.id] == mine }
            return (p.id, clash ? (p.planAccount?.email ?? mine) : mine)
        })
    }
}

/// One stretch of the model picker: a provider on its own, or a computer's Claude logins
/// together under "Claude" with a slider of their accounts, as on the desktop
/// (ModelPicker.tsx's account switcher, #2488).
public enum ModelSection: Equatable, Sendable, Identifiable {
    case provider(ModelGroup)
    /// Two or more Claude logins; only `shown`'s models are listed.
    case accounts([ModelGroup], shown: ModelGroup)

    public var id: String {
        switch self {
        case .provider(let g): g.id
        case .accounts: "claude-accounts"
        }
    }

    /// The list in sections. The Claude logins sit where the first of them was. The account
    /// on show is the one the user tapped (`viewing`), else the one the pick is on, else the
    /// first. A search lists every account's matches, each under its own name, so nothing it
    /// finds hides behind a tab.
    public static func of(_ groups: [ModelGroup], viewing: String?, selectedProvider: String?, searching: Bool) -> [ModelSection] {
        let logins = groups.filter { $0.provider.isClaudeLogin }
        guard !searching, logins.count > 1, let first = logins.first else { return groups.map { .provider($0) } }
        let shown = logins.first { $0.id == viewing } ?? logins.first { $0.id == selectedProvider } ?? first
        return groups.compactMap { g in
            if !g.provider.isClaudeLogin { return .provider(g) }
            return g.id == first.id ? .accounts(logins, shown: shown) : nil
        }
    }

    /// What tapping an account's tab picks: when the pick is on another of these accounts,
    /// the tapped account's id if it offers the same model (one tap to switch, as on the
    /// desktop); otherwise nil, and the tab only shows its models.
    public static func switchTo(_ logins: [ModelGroup], tapped: ModelGroup, selected: (String?, String?)) -> String? {
        guard let provider = selected.0, let model = selected.1, provider != tapped.id, model != autoModelId,
              logins.contains(where: { $0.id == provider }),
              tapped.models?.contains(where: { $0.id == model }) == true else { return nil }
        return tapped.id
    }
}
