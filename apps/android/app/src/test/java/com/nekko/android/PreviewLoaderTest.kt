package com.nekko.android

import com.nekko.android.previews.PreviewLoader
import com.nekko.protocol.Channels
import com.nekko.protocol.PreviewRequest
import com.nekko.protocol.RelayException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** AN-35: the preview reads, cached per chat, with the iPhone's PreviewLoaderTests cases. */
class PreviewLoaderTest {
    private fun json(s: String): JsonElement = Json.parseToJsonElement(s)

    @Test fun `reads once and reloads on request`() = runTest {
        val calls = mutableListOf<PreviewRequest>()
        val loader = PreviewLoader(read = { r ->
            calls += r
            json("""{"path":"/p/index.html","mime":"text/html","size":4,"kind":"text","content":"<b>","truncated":false}""")
        })
        val a = loader.artifact("s1", "/p/index.html")
        assertEquals("text/html", a.mime)
        assertEquals("utf-8", a.charset)
        assertEquals("<b>", a.data.toString(Charsets.UTF_8))
        loader.artifact("s1", "/p/index.html")
        assertEquals("the card's thumbnail and the window share one read", 1, calls.size)
        assertNotNull(loader.cachedArtifact("s1", "/p/index.html"))
        loader.artifact("s1", "/p/index.html", reload = true)
        assertEquals(2, calls.size)
        loader.artifact("s2", "/p/index.html")
        assertEquals("cached per chat", 3, calls.size)
        loader.forget("s1")
        assertNull(loader.cachedArtifact("s1", "/p/index.html"))
        assertNotNull(loader.cachedArtifact("s2", "/p/index.html"))
    }

    @Test fun `two reads of one file at once ask the computer once`() = runTest {
        val gate = CompletableDeferred<Unit>()
        var calls = 0
        val loader = PreviewLoader(read = {
            calls++
            gate.await()
            json("""{"path":"/a.svg","mime":"image/svg+xml","kind":"text","content":"<svg/>"}""")
        })
        val both = listOf(async { loader.artifact("s", "/a.svg") }, async { loader.artifact("s", "/a.svg") })
        yield()
        gate.complete(Unit)
        both.awaitAll()
        assertEquals(1, calls)
    }

    @Test fun `fetches loopback pages and refuses redirects away`() = runTest {
        val loader = PreviewLoader(read = { r ->
            if (r.args[1].jsonPrimitive.content.endsWith("/moved")) json("""{"status":302,"contentType":"","base64":""}""")
            else json("""{"url":"x","status":200,"contentType":"text/css; charset=utf-8","base64":"Yg=="}""")
        })
        val css = loader.fetch("s1", "http://localhost:5173/a.css")
        assertEquals("text/css", css.mime)
        assertEquals("utf-8", css.charset)
        assertEquals(200, css.status)
        val e = runCatching { loader.fetch("s1", "http://localhost:5173/moved") }.exceptionOrNull()
        assertEquals("a redirect away is not followed", "The preview server sent this page somewhere else.", e?.message)
    }

    @Test fun `truncated files and errors say why`() = runTest {
        val loader = PreviewLoader(read = { r ->
            if (r.channel == Channels.PREVIEW_FETCH) throw RelayException("unreachable: nothing is listening on 5173")
            json("""{"path":"/a.pdf","mime":"application/pdf","size":12000000,"kind":"binary","truncated":true}""")
        })
        val big = runCatching { loader.artifact("s1", "/a.pdf") }.exceptionOrNull()!!
        assertEquals("Too large to open on a phone (12 MB).", PreviewLoader.message(big, loopback = false))
        val down = runCatching { loader.fetch("s1", "http://localhost:5173/") }.exceptionOrNull()!!
        assertEquals("The preview server on your computer isn’t running.", PreviewLoader.message(down, loopback = true))
    }

    @Test fun `a large text file comes cut`() = runTest {
        val loader = PreviewLoader(read = {
            json("""{"path":"/big.txt","mime":"text/plain","size":3000000,"kind":"text","content":"start","truncated":true}""")
        })
        val body = loader.artifact("s", "/big.txt")
        assertTrue(body.truncated)
        assertEquals(3_000_000L, body.size)
        assertEquals("start", body.data.toString(Charsets.UTF_8))
    }

    @Test fun `the cache keeps to its limit`() = runTest {
        val loader = PreviewLoader(read = { r ->
            json("""{"path":${r.args[1]},"mime":"text/plain","kind":"text","content":"${"x".repeat(600)}"}""")
        }, byteLimit = 1000)
        loader.artifact("s", "/a.txt")
        loader.artifact("s", "/b.txt")
        assertNull("the oldest is dropped", loader.cachedArtifact("s", "/a.txt"))
        assertNotNull(loader.cachedArtifact("s", "/b.txt"))
    }

    @Test fun `thumbnail slots limit concurrent loads`() = runTest {
        val loader = PreviewLoader(read = { JsonNull }, thumbnailSlots = 2)
        var running = 0
        var peak = 0
        val jobs = (0 until 5).map {
            launch {
                loader.withThumbnailSlot {
                    running++
                    peak = maxOf(peak, running)
                    yield()
                    delay(5)
                    running--
                }
            }
        }
        jobs.forEach { it.join() }
        assertEquals(2, peak)
        assertEquals(0, running)
    }
}
