import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// How a computer's provider reads in the model pickers, with the desktop's wording (#2488).
final class ProviderAccountsTests: XCTestCase {
    private func claude(_ account: ProviderAccount?, label: String = "Claude subscription · account-2") -> PublicProvider {
        PublicProvider(id: "p1", kind: "claude-code", label: label, enabled: true, account: account)
    }

    private let org = ProviderAccount(signedIn: true, email: "philip@example.test", scope: .organization, name: "Nekko Labs", plan: "team")
    private let personal = ProviderAccount(signedIn: true, email: "philip@example.test", scope: .personal, name: "Personal", plan: "max")

    func testOrganizationSeatNamesItsOrganizationAndPlan() {
        let p = claude(org)
        XCTAssertEqual(p.accountTitle, "Nekko Labs · Team")
        XCTAssertEqual(p.accountCaption, "philip@example.test · Organization")
        XCTAssertEqual(p.shortName, "Claude · Nekko Labs")
        XCTAssertTrue(p.titleNamesPlan)
    }

    func testPersonalPlanReadsPersonal() {
        let p = claude(personal)
        XCTAssertEqual(p.accountTitle, "Personal · Max")
        XCTAssertEqual(p.accountCaption, "philip@example.test · Personal plan")
        XCTAssertEqual(p.shortName, "Claude · Personal")
    }

    func testTwoAccountsOnOneEmailReadApart() {
        let a = claude(org), b = claude(personal)
        XCTAssertNotEqual(a.accountTitle, b.accountTitle)
        XCTAssertNotEqual(a.accountCaption, b.accountCaption)
        XCTAssertNotEqual(a.shortName, b.shortName)
    }

    func testNoPlanIsJustTheName() {
        let p = claude(ProviderAccount(signedIn: true, email: "philip@example.test", scope: .organization, name: "Nekko Labs"))
        XCTAssertEqual(p.accountTitle, "Nekko Labs")
        XCTAssertFalse(p.titleNamesPlan)
        XCTAssertEqual(p.accountCaption, "philip@example.test · Organization")
    }

    func testPlanIsCapitalisedFirstLetterOnly() {
        let p = claude(ProviderAccount(signedIn: true, email: "a@example.test", scope: .personal, name: "Personal", plan: "max_20x"))
        XCTAssertEqual(p.accountTitle, "Personal · Max_20x")
    }

    func testSignedOutKeepsTheLabelWithACaption() {
        let p = claude(ProviderAccount(signedIn: false))
        XCTAssertEqual(p.accountTitle, "Claude subscription · account-2")
        XCTAssertEqual(p.accountCaption, "Signed out")
        XCTAssertEqual(p.shortName, "Claude subscription · account-2")
        XCTAssertFalse(p.titleNamesPlan)
    }

    func testApiKeyLoginKeepsTheLabel() {
        let p = claude(ProviderAccount(signedIn: true))
        XCTAssertEqual(p.accountTitle, "Claude subscription · account-2")
        XCTAssertNil(p.accountCaption)
        XCTAssertEqual(p.shortName, "Claude subscription · account-2")
    }

    func testNoAccountOrAnotherProviderKeepsTheLabel() {
        let unread = claude(nil)
        XCTAssertEqual(unread.accountTitle, unread.label)
        XCTAssertNil(unread.accountCaption)
        XCTAssertEqual(unread.shortName, unread.label)
        let api = PublicProvider(id: "o", kind: "openai", label: "OpenAI", enabled: true)
        XCTAssertEqual(api.accountTitle, "OpenAI")
        XCTAssertNil(api.accountCaption)
        XCTAssertEqual(api.shortName, "OpenAI")
        XCTAssertFalse(api.accountMatches("OpenAI"))
    }

    func testMissingNameFallsBackToTheScope() {
        XCTAssertEqual(claude(ProviderAccount(signedIn: true, email: "a@example.test", scope: .organization, plan: "enterprise")).accountTitle,
                       "Organization · Enterprise")
        XCTAssertEqual(claude(ProviderAccount(signedIn: true, email: "a@example.test", scope: .personal)).shortName, "Claude · Personal")
    }

    func testMissingScopeCaptionIsTheEmail() {
        XCTAssertEqual(claude(ProviderAccount(signedIn: true, email: "a@example.test", name: "Personal")).accountCaption, "a@example.test")
    }

    func testSearchMatchesTheAccountEmailAndName() {
        let p = claude(org)
        XCTAssertTrue(p.accountMatches("philip@"))
        XCTAssertTrue(p.accountMatches("EXAMPLE.test"))
        XCTAssertTrue(p.accountMatches("nekko labs"))
        XCTAssertFalse(p.accountMatches("acme"))
        XCTAssertFalse(p.accountMatches("  "))
        XCTAssertFalse(claude(ProviderAccount(signedIn: false)).accountMatches("Signed"))
    }

    func testReadsFromTheWire() throws {
        let raw = try JSONValue.parse(#"[{"id":"p1","kind":"claude-code","label":"Claude subscription · account-2","enabled":true,"account":{"signedIn":true,"email":"philip@example.test","scope":"organization","name":"Nekko Labs","plan":"team"}}]"#)
        let p = try XCTUnwrap(PublicProvider.list(raw).first)
        XCTAssertEqual([p.accountTitle, p.accountCaption, p.shortName], ["Nekko Labs · Team", "philip@example.test · Organization", "Claude · Nekko Labs"])
    }
}
