import Foundation
import XCTest
@testable import NekkoKit

/// The phone picker's context column comes only from what the provider lists (#2925).
final class PhoneModelMetaTests: XCTestCase {
    func testContextLengthOnlyWhereTheListGivesOne() {
        let openRouter = Data(#"{"data":[{"id":"openai/gpt-6.1-sol","name":"GPT-6.1 Sol","context_length":400000},{"id":"x/tiny","context_length":0}]}"#.utf8)
        let models = PhoneProviders.models(from: openRouter, kind: "openrouter")
        XCTAssertEqual(models.map(\.contextLength), [400_000, nil])
        let openai = Data(#"{"data":[{"id":"gpt-6.1-sol","created":1760000000}]}"#.utf8)
        XCTAssertNil(PhoneProviders.models(from: openai, kind: "openai").first?.contextLength)
        let anthropic = Data(#"{"data":[{"id":"claude-sonnet-5-5","display_name":"Claude Sonnet 5.5","max_input_tokens":1000000}]}"#.utf8)
        XCTAssertEqual(PhoneProviders.models(from: anthropic, kind: "anthropic").first?.contextLength, 1_000_000)
    }

    func testSavedModelsWithoutContextStillDecode() throws {
        let saved = Data(#"{"id":"gpt-6.1-sol","name":"gpt-6.1-sol"}"#.utf8)
        let model = try JSONDecoder().decode(PhoneModel.self, from: saved)
        XCTAssertNil(model.contextLength)
    }
}
