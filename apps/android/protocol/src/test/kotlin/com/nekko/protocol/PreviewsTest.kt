package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.URI

/** AN-35: links in a reply, the preview calls and the web view's URLs (the iPhone's ChatLinksTests and PreviewsTests), and the computer's phone-artifacts cases. */
class PreviewsTest {
    private val golden: JsonObject by lazy {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/tests/golden/phone-artifacts.json")
        assumeTrue("running outside the monorepo", f.exists())
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun json(s: String): JsonElement = Json.parseToJsonElement(s)
    private fun art(p: String) = ChatLinkTarget.Artifact(p)

    // ---- links (ChatLinksTests) ----

    @Test fun `absolute paths and file URLs are artifacts`() {
        assertEquals(art("/Users/a/proto/index.html"), ChatLinks.classify("/Users/a/proto/index.html"))
        assertEquals(art("C:/work/design.HTM"), ChatLinks.classify("C:/work/design.HTM"))
        assertEquals(art("C:/work/out/chart.png"), ChatLinks.classify("C:\\work\\out\\chart.png"))
        assertEquals(art("C:/my work/notes.md"), ChatLinks.classify("<C:\\my work\\notes.md>"))
        assertEquals(art("/Users/a/My Designs/x.html"), ChatLinks.classify("file:///Users/a/My%20Designs/x.html"))
        assertEquals(art("C:/x/y.svg"), ChatLinks.classify("file:///C:/x/y.svg"))
        assertEquals(art("/tmp/a.json"), ChatLinks.classify("file://localhost/tmp/a.json"))
        assertEquals(art("/tmp/a.html"), ChatLinks.classify("file:///tmp/a.html#section"))
        assertEquals(art("/Users/a/y/report.pdf"), ChatLinks.classify("/Users/a/x/../y/./report.pdf"))
        assertEquals(art("/Users/a/x y.csv"), ChatLinks.classify("/Users/a/x%20y.csv"))
    }

    @Test fun `other paths are not artifacts`() {
        for (s in listOf("/Users/a/build.sh", "/Users/a/folder", "docs/readme.md", "//server/share/x.html", "file://otherhost/x.html", "javascript:alert(1)", "#anchor", "")) {
            assertEquals(s, ChatLinkTarget.Unsupported, ChatLinks.classify(s))
        }
    }

    @Test fun `loopback and web links`() {
        for (s in listOf("http://localhost:5173/", "http://127.0.0.1:3000/app?x=1", "https://0.0.0.0:8443", "http://[::1]:8080/")) {
            assertEquals(s, ChatLinkTarget.Loopback(s), ChatLinks.classify(s))
        }
        assertEquals("no port: nothing the computer would serve", ChatLinkTarget.Unsupported, ChatLinks.classify("http://localhost/"))
        assertEquals(ChatLinkTarget.Web("https://example.com/a"), ChatLinks.classify("https://example.com/a"))
        assertEquals(ChatLinkTarget.Web("mailto:a@b.c"), ChatLinks.classify("mailto:a@b.c"))
    }

    @Test fun `linkable rewrites only what Markdown cannot read`() {
        assertEquals("file:///C:/my%20work/x.html", ChatLinks.fileUrl("C:/my work/x.html"))
        assertEquals(art("C:/my work/x.html"), ChatLinks.classify("file:///C:/my%20work/x.html"))
        assertEquals("See [it](file:///C:/a/b.html) now", ChatLinks.linkable("See [it](C:\\a\\b.html) now"))
        assertEquals("[x](file:///tmp/a%20b.md)", ChatLinks.linkable("[x](</tmp/a b.md>)"))
        assertEquals("[x](/tmp/a.md)", ChatLinks.linkable("[x](/tmp/a.md)"))
        assertEquals("[w](https://e.com)", ChatLinks.linkable("[w](https://e.com)"))
        assertEquals("`[x](C:\\a.html)`", ChatLinks.linkable("`[x](C:\\a.html)`"))
    }

    @Test fun `preview cards for a reply`() {
        val text = """
            Done. [Open the interactive design examples](/Users/p/proj/design-examples/index.html) and the
            [Browser preview](http://localhost:5173/). Also ![chart](/Users/p/proj/out/chart.png),
            [the same page again](/Users/p/proj/design-examples/INDEX.html), <http://127.0.0.1:3000/x>,
            a web [link](https://example.com) and `[code](/Users/p/no.html)`.
            ```
            [fenced](/Users/p/fenced.html)
            ```
            Bare: http://localhost:4000/app.
        """.trimIndent()
        val cards = ChatLinks.previews(text)
        assertEquals(
            listOf("Open the interactive design examples", "Browser preview", "chart", "Preview on 127.0.0.1:3000", "Preview on localhost:4000"),
            cards.map { it.title },
        )
        assertEquals(ChatPreviewLink.Target.Artifact("/Users/p/proj/design-examples/index.html"), cards[0].target)
        assertEquals("index.html", cards[0].detail)
        assertEquals(ArtifactKind.HTML, cards[0].kind)
        assertTrue(cards[0].isWeb)
        assertEquals(ChatPreviewLink.Target.Loopback("http://localhost:5173/"), cards[1].target)
        assertEquals("localhost:5173", cards[1].detail)
        assertNull(cards[1].kind)
        assertEquals(ArtifactKind.IMAGE, cards[2].kind)
        assertFalse(cards[2].isWeb)
        assertEquals("http://localhost:4000/app", cards[4].original)
    }

    @Test fun `a tapped link finds its card`() {
        val cards = ChatLinks.previews("[Design examples](C:\\p\\proto\\index.html)")
        assertEquals("Design examples", ChatLinks.preview(ChatLinks.fileUrl("C:/p/proto/index.html"), cards)?.title)
        assertEquals("Other", ChatLinks.preview("/tmp/other.svg")?.title)
        assertEquals("localhost:3000", ChatLinks.preview("http://localhost:3000")?.detail)
        assertNull(ChatLinks.preview("https://example.com"))
    }

    @Test fun `generic labels get a folder or file title`() {
        val cards = ChatLinks.previews("[index.html](/a/b/my-proto/index.html) [README](/a/notes_v2/README.md) [report_final.pdf](C:/x/report_final.pdf) [](/a/x.json)")
        assertEquals(listOf("My proto", "Notes v2", "Report final", "X"), cards.map { it.title })
    }

    @Test fun `artifact kinds`() {
        assertEquals(ArtifactKind.HTML, ArtifactKind.ofPath("/a/b.HTML"))
        assertEquals(ArtifactKind.IMAGE, ArtifactKind.ofPath("/a/b.webp"))
        assertEquals(ArtifactKind.TEXT, ArtifactKind.ofPath("/a/b.csv"))
        assertEquals(ArtifactKind.MARKDOWN, ArtifactKind.ofPath("/a/b.markdown"))
        assertNull(ArtifactKind.ofPath("/a/.env"))
        assertNull(ArtifactKind.ofPath("/a/b.exe"))
    }

    @Test fun `a card is only made for a file the computer would serve`() {
        // Without a chat folder, every absolute file the phone shows a card for is one the computer's link rules accept.
        for (case in golden["links"]!!.jsonArray.map { it.jsonObject }) {
            if (case["base"] !is JsonNull) continue
            val served = case["links"]!!.jsonObject["artifacts"]!!.jsonArray.map { it.jsonPrimitive.content.lowercase() }.toSet()
            // Malformed entries (not objects, no text) are there for the computer's parser; the phone only sees replies' text.
            for (m in (case["messages"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()) {
                if ((m["role"] as? JsonPrimitive)?.content != "assistant") continue
                val text = (m["content"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
                for (card in ChatLinks.previews(text)) {
                    val t = card.target as? ChatPreviewLink.Target.Artifact ?: continue
                    assertTrue("${t.path} in $served", t.path.lowercase() in served)
                }
            }
        }
    }

    // ---- the calls (PreviewsTests) ----

    @Test fun `requests are read class and the computer accepts them`() {
        val a = PreviewRequest.artifact("s1", "/tmp/out/report.md")
        assertEquals("artifact:read", a.channel)
        val f = PreviewRequest.fetch("s1", "http://localhost:5173/")
        assertEquals("""["s1","http://localhost:5173/",{"method":"GET"}]""", JsonArray(f.args).toString())
        assertFalse(a.channel in Channels.CHANGE)
        assertFalse(f.channel in Channels.CHANGE)
        val accepted = golden["screens"]!!.jsonArray.map { it.jsonObject }.filter { it["error"] == null }
            .flatMap { c -> listOfNotNull(c["args"], c["callArgs"]).map { c["channel"]!!.jsonPrimitive.content to it.toString() } }.toSet()
        for (r in listOf(a, f)) assertTrue("${r.channel} ${r.args}", (r.channel to JsonArray(r.args).toString()) in accepted)
    }

    @Test fun `decodes what the computer sends`() {
        val views = golden["views"]!!.jsonArray.map { it.jsonObject }
        fun view(channel: String, n: Int) = views.filter { it["channel"]!!.jsonPrimitive.content == channel }[n]["view"]
        val md = ArtifactFile.from(view("artifact:read", 0))!!
        assertEquals("# Hi\n", md.text)
        assertEquals(1_700_000_000_000L, md.mtime)
        val png = ArtifactFile.from(view("artifact:read", 1))!!
        assertArrayEquals(java.util.Base64.getDecoder().decode("iVBORw0KGgo="), png.data)
        assertNull(png.text)
        assertTrue(ArtifactFile.from(view("artifact:read", 2))!!.truncated)
        assertNull(ArtifactFile.from(view("artifact:read", 4)))
        val page = PreviewResponse.from(view("preview:fetch", 0))!!
        assertEquals(200, page.status)
        assertEquals("text/html", page.headers["content-type"])
        assertFalse(page.redirectedAway)
        assertTrue(PreviewResponse.from(view("preview:fetch", 1))!!.redirectedAway)
        assertTrue(PreviewResponse.from(view("preview:fetch", 2))!!.truncated)
        // A file without a type falls back to its extension.
        assertEquals("image/png", ArtifactFile.from(json("""{"path":"/tmp/a.png","mime":"","kind":"binary","base64":"AQID"}"""))!!.mime)
    }

    // ---- the web view's URLs ----

    @Test fun `artifact URLs round trip and resolve relative assets beside the page`() {
        for (path in listOf("/Users/a/My Designs/index.html", "C:/x/y z/page.html", "/tmp/a#b.html")) {
            val url = PreviewUrls.artifactUrl(path)
            assertTrue(url, url.startsWith("https://artifact.nekko.invalid/"))
            assertEquals(path, PreviewUrls.artifactPath(url))
        }
        val page = URI(PreviewUrls.artifactUrl("C:/proj/proto/index.html"))
        assertEquals("C:/proj/proto/styles/app.css", PreviewUrls.artifactPath(page.resolve("styles/app.css?v=2").toString()))
        assertNull(PreviewUrls.artifactPath("https://e.com/a.css"))
    }

    @Test fun `a preview keeps its origin and nothing else`() {
        val link = "https://127.0.0.1:8443/app?x=1#top"
        val local = PreviewUrls.previewUrl(link)!!
        assertEquals("https://preview.nekko.invalid/app?x=1#top", local)
        val asset = URI(local).resolve("/assets/main.js?t=1").toString()
        assertEquals("https://127.0.0.1:8443/assets/main.js?t=1", PreviewUrls.upstream(asset, link))
        assertNull("another origin", PreviewUrls.upstream("http://127.0.0.1:9999/", link))
        assertEquals("https://preview.nekko.invalid/", PreviewUrls.previewUrl("http://localhost:5173"))
        assertEquals("http://localhost:5173/", PreviewUrls.upstream("https://preview.nekko.invalid/", "http://localhost:5173"))
    }

    @Test fun `only the app's hosts load`() {
        assertTrue(PreviewUrls.isAllowed("https://artifact.nekko.invalid/a.html"))
        assertTrue(PreviewUrls.isAllowed("about:blank"))
        assertFalse(PreviewUrls.isAllowed("https://cdn.example.com/x.js"))
        assertFalse(PreviewUrls.isAllowed("http://artifact.nekko.invalid/a.html"))
        assertFalse(PreviewUrls.isAllowed("file:///etc/passwd"))
        assertTrue("connect-src 'self'" in PreviewUrls.CONTENT_SECURITY_POLICY)
    }

    @Test fun `content types and errors`() {
        assertEquals("text/html" to "UTF-8", PreviewUrls.splitContentType("text/HTML; charset=\"UTF-8\""))
        assertEquals("application/octet-stream", PreviewUrls.splitContentType("").first)
        assertEquals("font/woff2", PreviewUrls.mime("/a/b.woff2"))
        assertEquals("This file wasn’t linked in this chat.", PreviewError.plain("not-linked: this file was not linked in this chat", loopback = false))
        assertEquals("The preview server on your computer isn’t running.", PreviewError.plain("unreachable: nothing is listening on 5173", loopback = true))
        assertEquals(
            "Your computer can’t open previews for a phone yet. Update Nekko on it.",
            PreviewError.plain("Not allowed from a paired phone (channel-denied): preview:fetch", loopback = true),
        )
        assertEquals("timed out", PreviewError.plain("timed out", loopback = true))
    }
}
