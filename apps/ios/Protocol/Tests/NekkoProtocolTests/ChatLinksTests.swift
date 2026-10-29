import XCTest
@testable import NekkoProtocol

final class ChatLinksTests: XCTestCase {
    func testAbsolutePathsAndFileURLsAreArtifacts() {
        XCTAssertEqual(ChatLinks.classify("/Users/a/proto/index.html"), .artifact("/Users/a/proto/index.html"))
        XCTAssertEqual(ChatLinks.classify("C:/work/design.HTM"), .artifact("C:/work/design.HTM"))
        XCTAssertEqual(ChatLinks.classify("C:\\work\\out\\chart.png"), .artifact("C:/work/out/chart.png"))
        XCTAssertEqual(ChatLinks.classify("<C:\\my work\\notes.md>"), .artifact("C:/my work/notes.md"))
        XCTAssertEqual(ChatLinks.classify("file:///Users/a/My%20Designs/x.html"), .artifact("/Users/a/My Designs/x.html"))
        XCTAssertEqual(ChatLinks.classify("file:///C:/x/y.svg"), .artifact("C:/x/y.svg"))
        XCTAssertEqual(ChatLinks.classify("file://localhost/tmp/a.json"), .artifact("/tmp/a.json"))
        XCTAssertEqual(ChatLinks.classify("file:///tmp/a.html#section"), .artifact("/tmp/a.html"))
        XCTAssertEqual(ChatLinks.classify("/Users/a/x/../y/./report.pdf"), .artifact("/Users/a/y/report.pdf"))
        XCTAssertEqual(ChatLinks.classify("/Users/a/x%20y.csv"), .artifact("/Users/a/x y.csv"))
    }

    func testOtherPathsAreNotArtifacts() {
        XCTAssertEqual(ChatLinks.classify("/Users/a/build.sh"), .unsupported, "not previewable")
        XCTAssertEqual(ChatLinks.classify("/Users/a/folder"), .unsupported)
        XCTAssertEqual(ChatLinks.classify("docs/readme.md"), .unsupported, "relative: the phone has no base folder")
        XCTAssertEqual(ChatLinks.classify("//server/share/x.html"), .unsupported)
        XCTAssertEqual(ChatLinks.classify("file://otherhost/x.html"), .unsupported)
        XCTAssertEqual(ChatLinks.classify("javascript:alert(1)"), .unsupported)
        XCTAssertEqual(ChatLinks.classify("#anchor"), .unsupported)
        XCTAssertEqual(ChatLinks.classify(""), .unsupported)
    }

    func testLoopbackAndWebLinks() throws {
        for s in ["http://localhost:5173/", "http://127.0.0.1:3000/app?x=1", "https://0.0.0.0:8443", "http://[::1]:8080/"] {
            XCTAssertEqual(ChatLinks.classify(s), .loopback(try XCTUnwrap(URL(string: s))), s)
        }
        XCTAssertEqual(ChatLinks.classify("http://localhost/"), .unsupported, "no port: nothing the computer would serve")
        XCTAssertEqual(ChatLinks.classify("https://example.com/a"), .web(try XCTUnwrap(URL(string: "https://example.com/a"))))
        XCTAssertEqual(ChatLinks.classify("mailto:a@b.c"), .web(try XCTUnwrap(URL(string: "mailto:a@b.c"))))
    }

    func testClassifiesTheURLsMarkdownProduces() throws {
        // AttributedString(markdown:) hands a bare path over as a relative URL.
        XCTAssertEqual(ChatLinks.classify(try XCTUnwrap(URL(string: "/Users/a/x.html"))), .artifact("/Users/a/x.html"))
        let rewritten = ChatLinks.fileURL("C:/my work/x.html")
        XCTAssertEqual(rewritten, "file:///C:/my%20work/x.html")
        XCTAssertEqual(ChatLinks.classify(try XCTUnwrap(URL(string: rewritten))), .artifact("C:/my work/x.html"))
    }

    func testLinkableRewritesOnlyWhatMarkdownCannotRead() {
        XCTAssertEqual(ChatLinks.linkable("See [it](C:\\a\\b.html) now"), "See [it](file:///C:/a/b.html) now")
        XCTAssertEqual(ChatLinks.linkable("[x](</tmp/a b.md>)"), "[x](file:///tmp/a%20b.md)")
        XCTAssertEqual(ChatLinks.linkable("[x](/tmp/a.md)"), "[x](/tmp/a.md)")
        XCTAssertEqual(ChatLinks.linkable("[w](https://e.com)"), "[w](https://e.com)")
        XCTAssertEqual(ChatLinks.linkable("`[x](C:\\a.html)`"), "`[x](C:\\a.html)`")
    }

    func testPreviewCardsForAReply() throws {
        let text = """
        Done. [Open the interactive design examples](/Users/p/proj/design-examples/index.html) and the
        [Browser preview](http://localhost:5173/). Also ![chart](/Users/p/proj/out/chart.png),
        [the same page again](/Users/p/proj/design-examples/INDEX.html), <http://127.0.0.1:3000/x>,
        a web [link](https://example.com) and `[code](/Users/p/no.html)`.
        ```
        [fenced](/Users/p/fenced.html)
        ```
        Bare: http://localhost:4000/app.
        """
        let cards = ChatLinks.previews(in: text)
        XCTAssertEqual(cards.map(\.title), ["Open the interactive design examples", "Browser preview", "chart",
                                            "Preview on 127.0.0.1:3000", "Preview on localhost:4000"])
        XCTAssertEqual(cards[0].target, .artifact("/Users/p/proj/design-examples/index.html"))
        XCTAssertEqual(cards[0].detail, "index.html")
        XCTAssertEqual(cards[0].kind, .html)
        XCTAssertTrue(cards[0].isWeb)
        XCTAssertEqual(cards[1].target, .loopback(try XCTUnwrap(URL(string: "http://localhost:5173/"))))
        XCTAssertEqual(cards[1].detail, "localhost:5173")
        XCTAssertNil(cards[1].kind)
        XCTAssertEqual(cards[2].kind, .image)
        XCTAssertFalse(cards[2].isWeb)
        XCTAssertEqual(cards[4].original, "http://localhost:4000/app")
    }

    func testATappedLinkFindsItsCard() throws {
        let cards = ChatLinks.previews(in: "[Design examples](C:\\p\\proto\\index.html)")
        let tapped = try XCTUnwrap(URL(string: ChatLinks.fileURL("C:/p/proto/index.html")))
        XCTAssertEqual(ChatLinks.preview(for: tapped, in: cards)?.title, "Design examples")
        XCTAssertEqual(ChatLinks.preview(for: try XCTUnwrap(URL(string: "/tmp/other.svg")))?.title, "Other")
        XCTAssertEqual(ChatLinks.preview(for: try XCTUnwrap(URL(string: "http://localhost:3000")))?.detail, "localhost:3000")
        XCTAssertNil(ChatLinks.preview(for: try XCTUnwrap(URL(string: "https://example.com"))))
    }

    func testGenericLabelsGetAFolderOrFileTitle() {
        let cards = ChatLinks.previews(in: "[index.html](/a/b/my-proto/index.html) [README](/a/notes_v2/README.md) [report_final.pdf](C:/x/report_final.pdf) [](/a/x.json)")
        XCTAssertEqual(cards.map(\.title), ["My proto", "Notes v2", "Report final", "X"])
    }

    func testArtifactKinds() {
        XCTAssertEqual(ArtifactKind(path: "/a/b.HTML"), .html)
        XCTAssertEqual(ArtifactKind(path: "/a/b.webp"), .image)
        XCTAssertEqual(ArtifactKind(path: "/a/b.csv"), .text)
        XCTAssertEqual(ArtifactKind(path: "/a/b.markdown"), .markdown)
        XCTAssertNil(ArtifactKind(path: "/a/.env"))
        XCTAssertNil(ArtifactKind(path: "/a/b.exe"))
    }
}

final class PreviewsTests: XCTestCase {
    func testRequests() throws {
        let a = PreviewRequest.artifact("s1", "/tmp/a.html")
        XCTAssertEqual(a.channel, "artifact:read")
        XCTAssertEqual(a.args, [.string("s1"), .string("/tmp/a.html")])
        let f = PreviewRequest.fetch("s1", try XCTUnwrap(URL(string: "http://localhost:5173/x?y=1")))
        XCTAssertEqual(f.channel, "preview:fetch")
        XCTAssertEqual(f.args, [.string("s1"), .string("http://localhost:5173/x?y=1"), .object(["method": .string("GET")])])
        XCTAssertFalse(Channels.change.contains(a.channel), "read class")
        XCTAssertFalse(Channels.change.contains(f.channel), "read class")
    }

    func testDecodesAnArtifact() throws {
        let text = try XCTUnwrap(ArtifactFile.from(try JSONValue.parse("""
        {"path":"/tmp/a.html","name":"a.html","mime":"text/html; charset=utf-8","size":12,"mtime":1760000000000,"kind":"text","content":"<h1>hi</h1>","truncated":false}
        """)))
        XCTAssertEqual(text.text, "<h1>hi</h1>")
        XCTAssertEqual(text.mime, "text/html; charset=utf-8")
        XCTAssertEqual(text.mtime, Date(timeIntervalSince1970: 1_760_000_000))
        let bin = try XCTUnwrap(ArtifactFile.from(try JSONValue.parse("""
        {"path":"/tmp/a.png","mime":"","size":3,"mtime":0,"kind":"binary","base64":"AQID","truncated":false}
        """)))
        XCTAssertEqual(bin.data, Data([1, 2, 3]))
        XCTAssertEqual(bin.name, "a.png")
        XCTAssertEqual(bin.mime, "image/png", "falls back to the extension")
        XCTAssertNil(bin.mtime)
        XCTAssertNil(bin.text)
        XCTAssertTrue(try XCTUnwrap(ArtifactFile.from(try JSONValue.parse(#"{"path":"/a.pdf","kind":"binary","size":9e9,"truncated":true}"#))).truncated)
    }

    func testDecodesAFetch() throws {
        let r = try XCTUnwrap(PreviewResponse.from(try JSONValue.parse("""
        {"url":"http://localhost:5173/","status":200,"contentType":"text/html","headers":{"Content-Type":"text/html","etag":"x"},"base64":"PGI+","truncated":false}
        """)))
        XCTAssertEqual(r.status, 200)
        XCTAssertEqual(String(data: r.body, encoding: .utf8), "<b>")
        XCTAssertEqual(r.headers["content-type"], "text/html")
        XCTAssertFalse(r.redirectedAway)
        XCTAssertTrue(try XCTUnwrap(PreviewResponse.from(try JSONValue.parse(#"{"status":302,"base64":""}"#))).redirectedAway)
    }

    func testArtifactSchemeRoundTrips() throws {
        for path in ["/Users/a/My Designs/index.html", "C:/x/y z/page.html", "/tmp/a#b.html"] {
            let url = try XCTUnwrap(PreviewSchemes.url(artifact: path), path)
            XCTAssertEqual(url.scheme, "nekko-artifact")
            XCTAssertEqual(PreviewSchemes.artifactPath(url), path)
        }
        // A page's relative asset resolves beside it.
        let page = try XCTUnwrap(PreviewSchemes.url(artifact: "C:/proj/proto/index.html"))
        let css = try XCTUnwrap(URL(string: "styles/app.css?v=2", relativeTo: page))
        XCTAssertEqual(PreviewSchemes.artifactPath(css), "C:/proj/proto/styles/app.css")
        XCTAssertNil(PreviewSchemes.artifactPath(try XCTUnwrap(URL(string: "https://e.com/a.css"))))
    }

    func testPreviewSchemeKeepsTheOrigin() throws {
        let link = try XCTUnwrap(URL(string: "https://127.0.0.1:8443/app?x=1#top"))
        let local = try XCTUnwrap(PreviewSchemes.url(preview: link))
        XCTAssertEqual(local.absoluteString, "nekko-preview://127.0.0.1:8443/app?x=1#top")
        let asset = try XCTUnwrap(URL(string: "/assets/main.js?t=1", relativeTo: local))
        XCTAssertEqual(PreviewSchemes.upstream(asset, origin: link)?.absoluteString, "https://127.0.0.1:8443/assets/main.js?t=1")
        let other = try XCTUnwrap(URL(string: "nekko-preview://127.0.0.1:9999/"))
        XCTAssertNil(PreviewSchemes.upstream(other, origin: link), "another port is another origin")
        let bare = try XCTUnwrap(URL(string: "http://localhost:5173"))
        XCTAssertEqual(PreviewSchemes.url(preview: bare)?.absoluteString, "nekko-preview://localhost:5173/")
    }

    func testOnlyTheAppsSchemesLoad() throws {
        XCTAssertTrue(PreviewSchemes.isAllowed(try XCTUnwrap(URL(string: "nekko-artifact://local/a.html"))))
        XCTAssertTrue(PreviewSchemes.isAllowed(try XCTUnwrap(URL(string: "about:blank"))))
        XCTAssertFalse(PreviewSchemes.isAllowed(try XCTUnwrap(URL(string: "https://cdn.example.com/x.js"))))
        XCTAssertFalse(PreviewSchemes.isAllowed(try XCTUnwrap(URL(string: "file:///etc/passwd"))))
        let rules = try JSONValue.parse(PreviewSchemes.contentRules)
        XCTAssertEqual(rules.array?.first?["action"]?.str("type"), "block")
        XCTAssertEqual(rules.array?.count, 6)
    }

    func testContentTypesAndErrors() {
        XCTAssertEqual(PreviewSchemes.splitContentType("text/HTML; charset=\"UTF-8\"").mime, "text/html")
        XCTAssertEqual(PreviewSchemes.splitContentType("text/html; charset=\"UTF-8\"").charset, "UTF-8")
        XCTAssertEqual(PreviewSchemes.splitContentType("").mime, "application/octet-stream")
        XCTAssertEqual(PreviewSchemes.mime(forPath: "/a/b.woff2"), "font/woff2")
        XCTAssertEqual(PreviewError.plain("not-linked: this file was not linked in this chat", loopback: false), "This file wasn’t linked in this chat.")
        XCTAssertEqual(PreviewError.plain("unreachable: nothing is listening on 5173", loopback: true), "The preview server on your computer isn’t running.")
        XCTAssertEqual(PreviewError.plain("Not allowed from a paired phone (channel-denied): preview:fetch", loopback: true),
                       "Your computer can’t open previews for a phone yet. Update Nekko on it.")
        XCTAssertEqual(PreviewError.plain("timed out", loopback: true), "timed out")
    }
}
