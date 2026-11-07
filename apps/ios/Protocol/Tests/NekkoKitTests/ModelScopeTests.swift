import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// The model pickers' All / Cloud / Local tabs, after the desktop's Model source group.
final class ModelScopeTests: XCTestCase {
    private let cloud = PublicProvider(id: "anthropic", kind: "anthropic", label: "Claude API", enabled: true)
    private let local = PublicProvider(id: "ollama", kind: "ollama", label: "Ollama", enabled: true)
    private let server = PublicProvider(id: "llamacpp", kind: "llamacpp", label: "Model Server", enabled: true)
    private let off = PublicProvider(id: "lmstudio", kind: "lmstudio", label: "LM Studio", enabled: false)

    private func groups() -> [ModelGroup] {
        [cloud, local, server].map { ModelGroup(provider: $0, models: [], error: nil) }
    }

    func testTabsAreAllCloudLocalInTheDesktopOrderAndOpenOnAll() {
        XCTAssertEqual(ModelScope.allCases, [.all, .cloud, .local])
    }

    func testAllListsEveryProviderInOrder() {
        XCTAssertEqual(ModelScope.all.groups(groups()).map(\.id), ["anthropic", "ollama", "llamacpp"])
    }

    func testCloudListsOnlyCloudApis() {
        XCTAssertEqual(ModelScope.cloud.groups(groups()).map(\.id), ["anthropic"])
    }

    func testLocalListsOnlyModelServersOnTheComputer() {
        XCTAssertEqual(ModelScope.local.groups(groups()).map(\.id), ["ollama", "llamacpp"])
    }

    func testAnEmptyTabListsNothing() {
        let onlyCloud = [ModelGroup(provider: cloud, models: [], error: nil)]
        XCTAssertTrue(ModelScope.local.groups(onlyCloud).isEmpty)
    }

    func testStarredFollowTheTabAndSkipProvidersThatAreOff() {
        let keys = ["anthropic::claude-opus-5-5", "ollama::qwen3", "lmstudio::gemma", "gone::x"]
        let providers = [cloud, local, off]
        XCTAssertEqual(ModelScope.all.favorites(keys, providers: providers), ["anthropic::claude-opus-5-5", "ollama::qwen3"])
        XCTAssertEqual(ModelScope.cloud.favorites(keys, providers: providers), ["anthropic::claude-opus-5-5"])
        XCTAssertEqual(ModelScope.local.favorites(keys, providers: providers), ["ollama::qwen3"])
    }

    func testAProviderIdThatPrefixesAnotherDoesNotClaimItsStars() {
        let short = PublicProvider(id: "open", kind: "ollama", label: "Open", enabled: true)
        XCTAssertEqual(ModelScope.local.favorites(["openai::gpt-5"], providers: [short]), [])
    }

    func testComputerDetailsFilterModelsByTheirProviderNotTheirName() {
        let models = ModelInfo.list([
            ["id": "same", "providerId": "anthropic", "name": "Cloud model"],
            ["id": "same", "providerId": "ollama", "name": "Local model"],
            ["id": "unknown", "providerId": "removed"]
        ])
        XCTAssertEqual(ModelScope.all.models(models, providers: [cloud, local]).count, 3)
        XCTAssertEqual(ModelScope.cloud.models(models, providers: [cloud, local]).map(\.providerId), ["anthropic"])
        XCTAssertEqual(ModelScope.local.models(models, providers: [cloud, local]).map(\.providerId), ["ollama"])
    }

    func testThisIPhonesProvidersAreCloud() {
        let p = PhoneProvider(id: "anthropic", kind: "anthropic", label: "Claude API", baseUrl: "https://api.anthropic.com")
        XCTAssertTrue(ModelScope.all.includes(p))
        XCTAssertTrue(ModelScope.cloud.includes(p))
        XCTAssertFalse(ModelScope.local.includes(p))
    }
}
