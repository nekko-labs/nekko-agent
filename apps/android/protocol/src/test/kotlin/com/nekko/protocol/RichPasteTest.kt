package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

/** MD-6: *Paste as Markdown*, clipboard HTML → Markdown, including what must never come through (the iPhone's RichPasteTests). */
class RichPasteTest {
    private fun md(html: String, plain: String = "plain") = RichPaste.markdown(html, plain)

    @Test fun `inline styles and links`() {
        assertEquals("Some **bold**, *italic*, ~~gone~~ and `x < y`.", md("<p>Some <b>bold</b>, <em>italic</em>, <del>gone</del> and <code>x &lt; y</code>.</p>"))
        assertEquals("[the docs](https://example.com/a%28b%29) and [mail](mailto:hi@x.dev)", md("""<a href="https://example.com/a(b)">the docs</a> and <a href="mailto:hi@x.dev">mail</a>"""))
        // Spaces stay outside the marks.
        assertEquals("a **bold** b", md("<p>a<strong> bold </strong>b</p>"))
    }

    @Test fun `headings, quotes, code and rules`() {
        val html = "<h1>Title</h1><p>Intro</p><h3>Part</h3>\n<blockquote><p>Quoted</p><p>Twice</p></blockquote>\n" +
            "<pre><code class=\"language-swift\">let a = 1\nlet b = 2\n</code></pre><hr><p>End</p>"
        assertEquals("# Title\n\nIntro\n\n### Part\n\n> Quoted\n>\n> Twice\n\n```swift\nlet a = 1\nlet b = 2\n```\n\n---\n\nEnd", md(html))
    }

    @Test fun `nested lists`() {
        val html = "<ul><li>one<ul><li>nested <b>bold</b><ol><li>deep</li><li>deeper</li></ol></li></ul></li><li>two</li></ul>"
        assertEquals("- one\n  - nested **bold**\n    1. deep\n    2. deeper\n- two", md(html))
        assertEquals("3. three\n4. four", md("""<ol start="3"><li>three<li>four</ol>"""))
        assertEquals("- [x] done\n- [ ] todo", md("""<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>"""))
        // The result reads back as the same tree.
        val list = (MarkdownParser.parse(md(html)).first() as MarkdownBlock.ListBlock).list
        assertEquals(true, list.items.first().children.first().items.first().children.first().ordered)
    }

    @Test fun `simple tables`() {
        val html = "<table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Nekko</td><td><b>done</b></td></tr><tr><td>a|b</td></tr></tbody></table>"
        assertEquals("| Name | Status |\n| --- | --- |\n| Nekko | **done** |\n| a\\|b |  |", md(html))
        val t = (MarkdownParser.parse(md(html)).first() as MarkdownBlock.Table).table
        assertEquals(listOf("a|b", ""), t.rows[1])
    }

    @Test fun `Google Docs wrapper`() {
        val html = """<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700;">Bold</span><span style="font-weight:400;"> and </span><span style="font-style:italic;">it</span></p><ul><li><p>item</p></li></ul></b>"""
        assertEquals("**Bold** and *it*\n\n- item", md(html))
    }

    @Test fun `Markdown characters in text are escaped`() {
        assertEquals("2\\*3 and snake\\_case \\[x\\]", md("<p>2*3 and snake_case [x]</p>"))
    }

    @Test fun `entities and whitespace`() {
        assertEquals("Tom & Jerry — 😀 ’", md("<p>Tom&nbsp;&amp;\n   Jerry &#8212; &#x1F600; &rsquo;</p>"))
        assertEquals("line one\nline two", md("<p>line one<br>line two</p>"))
    }

    @Test fun `active content is dropped`() {
        val html = "<p>Safe</p><script>alert('x')</script><style>p{color:red}</style>\n" +
            "<iframe src=\"https://evil.example\"></iframe><img src=\"https://tracker.example/p.gif\" onerror=\"alert(1)\">\n" +
            "<svg><script>alert(2)</script></svg><object data=\"x.swf\"></object><!-- <p>hidden</p> -->\n" +
            "<p onclick=\"alert(3)\">Also safe</p>"
        assertEquals("Safe\n\nAlso safe", md(html))
    }

    @Test fun `only web and mail links are kept`() {
        assertEquals("click", md("""<a href="javascript:alert(1)">click</a>"""))
        assertEquals("click", md("""<a href=" JavaScript:alert(1)">click</a>"""))
        assertEquals("x", md("""<a href="data:text/html,<script>">x</a>"""))
        assertEquals("f", md("""<a href="file:///etc/passwd">f</a>"""))
        assertEquals("[ok](HTTPS://x.dev)", md("""<a href="HTTPS://x.dev">ok</a>"""))
    }

    @Test fun `a script that never closes swallows only itself`() {
        assertEquals("before", md("<p>before</p><script>while(1){}"))
    }

    @Test fun `falls back to plain text`() {
        assertEquals("a\nb", RichPaste.markdown(null, "a\r\nb"))
        assertEquals("plain", RichPaste.markdown("<script>x</script>", "plain"))
        assertEquals("plain", RichPaste.markdown("a".repeat(RichPaste.MAX_HTML + 1), "plain"))
    }

    @Test fun `malformed HTML does not crash`() {
        for (html in listOf("<", "<<p>>", "</b></i>text", "<a href=", "<p><li>x", "&#xZZZ; &#99999999999;", "<table><td>x")) md(html)
    }
}
