import Foundation
import XCTest
@testable import NekkoProtocol

/// *Paste as Markdown* (MD-4): clipboard HTML → Markdown, including what must never come through.
final class RichPasteTests: XCTestCase {
    private func md(_ html: String, plain: String = "plain") -> String { RichPaste.markdown(html: html, plain: plain) }

    func testInlineStylesAndLinks() {
        XCTAssertEqual(md("<p>Some <b>bold</b>, <em>italic</em>, <del>gone</del> and <code>x &lt; y</code>.</p>"),
                       "Some **bold**, *italic*, ~~gone~~ and `x < y`.")
        XCTAssertEqual(md(#"<a href="https://example.com/a(b)">the docs</a> and <a href="mailto:hi@x.dev">mail</a>"#),
                       "[the docs](https://example.com/a%28b%29) and [mail](mailto:hi@x.dev)")
        // Spaces stay outside the marks.
        XCTAssertEqual(md("<p>a<strong> bold </strong>b</p>"), "a **bold** b")
    }

    func testHeadingsQuotesCodeAndRules() {
        let html = """
        <h1>Title</h1><p>Intro</p><h3>Part</h3>
        <blockquote><p>Quoted</p><p>Twice</p></blockquote>
        <pre><code class="language-swift">let a = 1
        let b = 2
        </code></pre><hr><p>End</p>
        """
        XCTAssertEqual(md(html), "# Title\n\nIntro\n\n### Part\n\n> Quoted\n>\n> Twice\n\n```swift\nlet a = 1\nlet b = 2\n```\n\n---\n\nEnd")
    }

    func testNestedLists() {
        let html = "<ul><li>one<ul><li>nested <b>bold</b><ol><li>deep</li><li>deeper</li></ol></li></ul></li><li>two</li></ul>"
        XCTAssertEqual(md(html), "- one\n  - nested **bold**\n    1. deep\n    2. deeper\n- two")
        XCTAssertEqual(md(#"<ol start="3"><li>three<li>four</ol>"#), "3. three\n4. four")
        XCTAssertEqual(md(#"<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>"#),
                       "- [x] done\n- [ ] todo")
        // The result reads back as the same tree.
        guard case .list(let list)? = MarkdownParser.parse(md(html)).first else { return XCTFail("a list") }
        XCTAssertEqual(list.items.first?.children.first?.items.first?.children.first?.ordered, true)
    }

    func testSimpleTables() {
        let html = "<table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Nekko</td><td><b>done</b></td></tr><tr><td>a|b</td></tr></tbody></table>"
        XCTAssertEqual(md(html), "| Name | Status |\n| --- | --- |\n| Nekko | **done** |\n| a\\|b |  |")
        guard case .table(let t)? = MarkdownParser.parse(md(html)).first else { return XCTFail("a table") }
        XCTAssertEqual(t.rows[1], ["a|b", ""])
    }

    func testGoogleDocsWrapper() {
        let html = #"<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700;">Bold</span><span style="font-weight:400;"> and </span><span style="font-style:italic;">it</span></p><ul><li><p>item</p></li></ul></b>"#
        XCTAssertEqual(md(html), "**Bold** and *it*\n\n- item")
    }

    func testMarkdownCharactersInTextAreEscaped() {
        XCTAssertEqual(md("<p>2*3 and snake_case [x]</p>"), "2\\*3 and snake\\_case \\[x\\]")
    }

    func testEntitiesAndWhitespace() {
        XCTAssertEqual(md("<p>Tom&nbsp;&amp;\n   Jerry &#8212; &#x1F600; &rsquo;</p>"), "Tom & Jerry — 😀 ’")
        XCTAssertEqual(md("<p>line one<br>line two</p>"), "line one\nline two")
    }

    // MARK: Security

    func testActiveContentIsDropped() {
        let html = """
        <p>Safe</p><script>alert('x')</script><style>p{color:red}</style>
        <iframe src="https://evil.example"></iframe><img src="https://tracker.example/p.gif" onerror="alert(1)">
        <svg><script>alert(2)</script></svg><object data="x.swf"></object><!-- <p>hidden</p> -->
        <p onclick="alert(3)">Also safe</p>
        """
        XCTAssertEqual(md(html), "Safe\n\nAlso safe")
    }

    func testOnlyWebAndMailLinksAreKept() {
        XCTAssertEqual(md(#"<a href="javascript:alert(1)">click</a>"#), "click")
        XCTAssertEqual(md(#"<a href=" JavaScript:alert(1)">click</a>"#), "click")
        XCTAssertEqual(md(#"<a href="data:text/html,<script>">x</a>"#), "x")
        XCTAssertEqual(md(#"<a href="file:///etc/passwd">f</a>"#), "f")
        XCTAssertEqual(md(#"<a href="HTTPS://x.dev">ok</a>"#), "[ok](HTTPS://x.dev)")
    }

    func testAScriptThatNeverClosesSwallowsOnlyItself() {
        XCTAssertEqual(md("<p>before</p><script>while(1){}"), "before")
    }

    func testFallsBackToPlainText() {
        XCTAssertEqual(RichPaste.markdown(html: nil, plain: "a\r\nb"), "a\nb")
        XCTAssertEqual(RichPaste.markdown(html: "<script>x</script>", plain: "plain"), "plain")
        XCTAssertEqual(RichPaste.markdown(html: String(repeating: "a", count: RichPaste.maxHTML + 1), plain: "plain"), "plain")
    }

    func testMalformedHTMLDoesNotCrash() {
        for html in ["<", "<<p>>", "</b></i>text", "<a href=", "<p><li>x", "&#xZZZ; &#99999999999;", "<table><td>x"] {
            _ = md(html)
        }
    }
}
