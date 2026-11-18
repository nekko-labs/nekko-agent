import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Photos in chats that run on this iPhone (#2926): what each provider is sent, and what is kept.
@MainActor
final class PhoneChatPhotosTests: XCTestCase {
    let jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    let png = "data:image/png;base64,iVBORw0KGgo="

    func testClaudeGetsImageBlocksBeforeTheText() async throws {
        let claude = PhoneProvider(id: "c", kind: "anthropic", label: "C", baseUrl: "https://api.anthropic.com")
        let msgs = [PhoneMessage(id: "1", role: .user, text: "What is this?", at: 1, images: [jpeg, png])]
        let r = try PhoneProviders.chatRequest(claude, key: "k", model: "claude-opus-5-5", messages: msgs)
        let parts = try XCTUnwrap(r.body?["messages"]?.array?.first?["content"]?.array)
        XCTAssertEqual(parts.map { $0.str("type") }, ["image", "image", "text"])
        XCTAssertEqual(parts[0]["source"]?.str("type"), "base64")
        XCTAssertEqual(parts[0]["source"]?.str("media_type"), "image/jpeg")
        XCTAssertEqual(parts[0]["source"]?.str("data"), "/9j/4AAQSkZJRg==")
        XCTAssertEqual(parts[1]["source"]?.str("media_type"), "image/png")
        XCTAssertEqual(parts[2].str("text"), "What is this?")

        let vertex = PhoneProvider(id: "v", kind: "vertex", label: "V", baseUrl: "https://aiplatform.googleapis.com/v1/projects/p/locations/global")
        let rv = try PhoneProviders.chatRequest(vertex, key: "t", model: "claude-sonnet-5-5", messages: msgs)
        XCTAssertEqual(rv.body?["messages"]?.array?.first?["content"]?.array?.first?.str("type"), "image")
    }

    func testOpenAiRouteGetsImageUrlPartsAfterTheText() async throws {
        let msgs = [PhoneMessage(id: "1", role: .user, text: "Describe", at: 1, images: [jpeg])]
        for kind in ["openai", "openrouter", "gemini", "ollama-cloud"] {
            let k = try XCTUnwrap(PhoneProviders.kind(kind))
            let p = PhoneProvider(id: kind, kind: kind, label: kind, baseUrl: k.defaultUrl)
            let r = try PhoneProviders.chatRequest(p, key: "k", model: "m", messages: msgs)
            let user = try XCTUnwrap(r.body?["messages"]?.array?.last)
            let parts = try XCTUnwrap(user["content"]?.array, kind)
            XCTAssertEqual(parts.map { $0.str("type") }, ["text", "image_url"], kind)
            XCTAssertEqual(parts[1]["image_url"]?.str("url"), jpeg, kind)
        }
    }

    func testTextOnlyTurnsKeepAPlainStringAndPhotoOnlyTurnsHaveNoTextPart() async throws {
        let p = PhoneProvider(id: "o", kind: "openai", label: "O", baseUrl: "https://api.openai.com/v1")
        let msgs = [PhoneMessage(id: "1", role: .user, text: "Hi", at: 1), PhoneMessage(id: "2", role: .assistant, text: "Hello", at: 2),
                    PhoneMessage(id: "3", role: .user, text: "", at: 3, images: [png])]
        let turns = try XCTUnwrap(PhoneProviders.chatRequest(p, key: "k", model: "gpt-5", messages: msgs).body?["messages"]?.array)
        XCTAssertEqual(turns.count, 4, "system, both texts, and the photo-only turn")
        XCTAssertEqual(turns[1].str("content"), "Hi")
        XCTAssertEqual(turns[3]["content"]?.array?.map { $0.str("type") }, ["image_url"])

        let claude = PhoneProvider(id: "c", kind: "anthropic", label: "C", baseUrl: "https://api.anthropic.com")
        let last = try XCTUnwrap(PhoneProviders.chatRequest(claude, key: "k", model: "claude-opus-5-5", messages: msgs).body?["messages"]?.array?.last)
        XCTAssertEqual(last["content"]?.array?.map { $0.str("type") }, ["image"], "Claude refuses an empty text block")
    }

    func testOnlyImageDataUrlsAreSent() async {
        XCTAssertNotNil(PhoneProviders.imagePart(jpeg))
        XCTAssertEqual(PhoneProviders.imagePart("data:image/webp;base64,UklGRg==")?.mediaType, "image/webp")
        XCTAssertNil(PhoneProviders.imagePart("https://example.com/cat.jpg"), "no remote URL is fetched on the user's behalf")
        XCTAssertNil(PhoneProviders.imagePart("data:image/svg+xml;base64,PHN2Zz4="))
        XCTAssertNil(PhoneProviders.imagePart("data:image/jpeg;base64,"))
        XCTAssertNil(PhoneProviders.imagePart("data:image/jpeg;base64,abc\"}"))
        XCTAssertNil(PhoneProviders.imagePart("data:image/jpeg;base64," + String(repeating: "A", count: PhoneProviders.maxImageBytes)))
    }

    func testAPhotoMessageIsSentKeptAndReadBack() async throws {
        let secrets = MemoryStore(), files = MemoryOfflineFiles(), http = FakePhoneHTTP()
        var n = 0
        let make = { PhoneChats(secrets: secrets, files: files, http: http, now: { 1_000 }, newId: { n += 1; return "m\(n)" }) }
        let s = make()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        http.answers = [(200, [#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A cat"}}"#, #"data: {"type":"message_stop"}"#])]
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "", images: [jpeg, "not a photo", png, png, png, png])
        await s.settled(id)
        let chat = try XCTUnwrap(s.chat(id))
        XCTAssertEqual(chat.title, "Photo")
        XCTAssertEqual(chat.messages.first?.images, [jpeg, png, png, png], "four at most, and only photos")
        XCTAssertEqual(chat.messages.last?.text, "A cat")
        XCTAssertEqual(make().chat(id)?.messages.first?.images?.count, 4)

        s.send(id, "  ")
        XCTAssertEqual(s.chat(id)?.messages.count, 2, "nothing to send")
    }

    func testChatsSavedBeforePhotosStillLoad() async throws {
        let old = Data(#"{"id":"1","role":"user","text":"Hi","at":1}"#.utf8)
        let m = try JSONDecoder().decode(PhoneMessage.self, from: old)
        XCTAssertNil(m.images)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(PhoneMessage(id: "1", role: .user, text: "Hi", at: 1, images: [])), as: UTF8.self).contains("images"))
    }

    func testWhichModelsTakePhotos() async {
        let router = Data(#"{"data":[{"id":"a/vision","architecture":{"input_modalities":["text","image"]}},{"id":"b/text","architecture":{"input_modalities":["text"]}},{"id":"c/unknown"}]}"#.utf8)
        XCTAssertEqual(PhoneProviders.models(from: router, kind: "openrouter").map(\.acceptsImages), [true, false, nil])
        let openai = Data(#"{"data":[{"id":"gpt-5"}]}"#.utf8)
        XCTAssertNil(PhoneProviders.models(from: openai, kind: "openai").first?.acceptsImages, "OpenAI's list doesn't say")
    }
}
