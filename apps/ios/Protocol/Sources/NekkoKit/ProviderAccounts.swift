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
