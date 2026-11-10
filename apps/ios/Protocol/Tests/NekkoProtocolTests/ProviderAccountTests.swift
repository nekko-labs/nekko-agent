import XCTest
@testable import NekkoProtocol

/// The `account` the computer adds to a Claude subscription provider in `providers:list`
/// (PHONE_PROVIDER_VIEW passes only signedIn, email, scope, name and plan), #2488.
final class ProviderAccountTests: XCTestCase {
    private func parse(_ json: String) throws -> [PublicProvider] { PublicProvider.list(try JSONValue.parse(json)) }

    func testReadsAnOrganizationSeatAndAPersonalPlanOnOneEmail() throws {
        let list = try parse(#"""
        [{"id":"p1","kind":"claude-code","label":"Claude subscription · account-2","enabled":true,
          "account":{"signedIn":true,"email":"philip@example.test","scope":"organization","name":"Nekko Labs","plan":"team"}},
         {"id":"p2","kind":"claude-code","label":"Claude subscription","enabled":true,
          "account":{"signedIn":true,"email":"philip@example.test","scope":"personal","name":"Personal","plan":"max"}}]
        """#)
        XCTAssertEqual(list.map(\.account), [
            ProviderAccount(signedIn: true, email: "philip@example.test", scope: .organization, name: "Nekko Labs", plan: "team"),
            ProviderAccount(signedIn: true, email: "philip@example.test", scope: .personal, name: "Personal", plan: "max"),
        ])
        XCTAssertEqual(list[0].label, "Claude subscription · account-2")
    }

    func testMissingSignedOutAndApiKeyAccounts() throws {
        let list = try parse(#"""
        [{"id":"a","kind":"claude-code","label":"A","enabled":true},
         {"id":"b","kind":"claude-code","label":"B","enabled":true,"account":{"signedIn":false}},
         {"id":"c","kind":"claude-code","label":"C","enabled":true,"account":{"signedIn":true}},
         {"id":"d","kind":"claude-code","label":"D","enabled":true,"account":{"signedIn":true,"email":"x@example.test","scope":"personal","name":"Personal"}},
         {"id":"e","kind":"openai","label":"E","enabled":true,"account":null}]
        """#)
        XCTAssertNil(list[0].account)
        XCTAssertEqual(list[1].account, ProviderAccount(signedIn: false))
        XCTAssertEqual(list[2].account, ProviderAccount(signedIn: true))
        XCTAssertEqual(list[3].account, ProviderAccount(signedIn: true, email: "x@example.test", scope: .personal, name: "Personal"))
        XCTAssertNil(list[3].account?.plan)
        XCTAssertNil(list[4].account)
    }

    func testUnknownScopeAndBlankFieldsReadAsMissing() throws {
        let list = try parse(#"""
        [{"id":"a","kind":"claude-code","label":"A","enabled":true,
          "account":{"signedIn":true,"email":" ","scope":"household","name":"","plan":""}}]
        """#)
        XCTAssertEqual(list[0].account, ProviderAccount(signedIn: true))
    }

    func testExistingInitStaysSourceCompatible() {
        let p = PublicProvider(id: "o", kind: "openai", label: "OpenAI", enabled: true)
        XCTAssertNil(p.account)
    }
}
