package com.nekko.protocol

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tiny image headers: enough bytes for [PhotoEdit.size], no pixels (the iPhone's PhotoHeaders). */
object PhotoHeaders {
    fun dataUrl(type: String, bytes: List<Int>) = "data:$type;base64," + Base64.getEncoder().encodeToString(ByteArray(bytes.size) { bytes[it].toByte() })
    private fun be16(n: Int) = listOf(n shr 8 and 0xFF, n and 0xFF)
    private fun be32(n: Int) = listOf(n shr 24 and 0xFF, n shr 16 and 0xFF, n shr 8 and 0xFF, n and 0xFF)
    private fun le16(n: Int) = listOf(n and 0xFF, n shr 8 and 0xFF)
    private fun le24(n: Int) = listOf(n and 0xFF, n shr 8 and 0xFF, n shr 16 and 0xFF)
    private fun le32(n: Int) = listOf(n and 0xFF, n shr 8 and 0xFF, n shr 16 and 0xFF, n ushr 24 and 0xFF)
    private fun ascii(s: String) = s.map { it.code }
    private fun riff(chunk: String, body: List<Int>) = dataUrl("image/webp", ascii("RIFF") + listOf(0, 0, 0, 0) + ascii("WEBP") + ascii(chunk) + le32(body.size) + body)

    fun png(w: Int, h: Int) = dataUrl("image/png", listOf(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) + be32(13) + ascii("IHDR") + be32(w) + be32(h) + listOf(8, 6, 0, 0, 0, 0, 0, 0, 0))
    fun jpeg(w: Int, h: Int) = dataUrl("image/jpeg", listOf(0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10) + ascii("JFIF") + listOf(0, 1, 1, 0, 0, 1, 0, 1, 0, 0) +
        listOf(0xFF, 0xC0, 0x00, 0x11, 0x08) + be16(h) + be16(w) + listOf(3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9))
    fun webpVP8X(w: Int, h: Int) = riff("VP8X", listOf(0, 0, 0, 0) + le24(w - 1) + le24(h - 1))
    fun webpVP8L(w: Int, h: Int) = riff("VP8L", listOf(0x2F) + le32((w - 1) or ((h - 1) shl 14)) + listOf(0, 0, 0, 0, 0))
    fun webpVP8(w: Int, h: Int) = riff("VP8 ", listOf(0, 0, 0, 0x9D, 0x01, 0x2A) + le16(w) + le16(h))
}

/** The desktop's photoEdit.ts, ported (#2230): the iPhone's PhotoEditTests, the same numbers. */
class PhotoEditTest {
    private val chosen = PixelSize(1024, 1024)

    @Test fun fitScalesDownToTheLongestSideNeverUp() {
        assertEquals(PixelSize(1536, 1152), PhotoEdit.fit(PixelSize(4032, 3024)))
        assertEquals(PixelSize(1152, 1536), PhotoEdit.fit(PixelSize(3024, 4032)))
        assertEquals(PixelSize(800, 600), PhotoEdit.fit(PixelSize(800, 600)))
        assertEquals(PixelSize(2, 1), PhotoEdit.fit(PixelSize(3, 1), edge = 2))
        assertEquals(PixelSize(1536, 1), PhotoEdit.fit(PixelSize(10000, 1)))
    }

    @Test fun editSizeIsThePhotosShapeAtTheChatsPixelCountInMultiplesOf64() {
        assertEquals(PixelSize(896, 1152), PhotoEdit.editSize(PixelSize(3024, 4032), chosen))
        assertEquals(PixelSize(1344, 768), PhotoEdit.editSize(PixelSize(1920, 1080), chosen))
        assertEquals(chosen, PhotoEdit.editSize(PixelSize(500, 500), chosen))
        assertEquals(PixelSize(2048, 256), PhotoEdit.editSize(PixelSize(10000, 100), chosen))
        assertEquals(PixelSize(256, 2048), PhotoEdit.editSize(PixelSize(100, 10000), chosen))
        assertEquals(chosen, PhotoEdit.editSize(PixelSize(0, 0), chosen))
        assertEquals(PixelSize(1024, 1024), PhotoEdit.editSize(PixelSize(1, 1), PixelSize(768, 1344)))
        for (w in listOf(1, 333, 1920, 4032)) for (h in listOf(1, 500, 1080, 3024)) {
            val s = PhotoEdit.editSize(PixelSize(w, h), chosen)
            assertTrue("$s", s.width in 256..2048 && s.width % 64 == 0 && s.height in 256..2048 && s.height % 64 == 0)
        }
    }

    @Test fun halvesRoundUpLikeMathRound() {
        assertEquals(PixelSize(1152, 1152), PhotoEdit.editSize(PixelSize(1, 1), PixelSize(1120, 1120)))
    }

    @Test fun readsPngJpegAndWebPHeaderSizes() {
        assertEquals(PixelSize(1920, 1080), PhotoEdit.size(PhotoHeaders.png(1920, 1080)))
        assertEquals(PixelSize(3024, 4032), PhotoEdit.size(PhotoHeaders.jpeg(3024, 4032)))
        assertEquals(PixelSize(1536, 1152), PhotoEdit.size(PhotoHeaders.webpVP8X(1536, 1152)))
        assertEquals(PixelSize(640, 480), PhotoEdit.size(PhotoHeaders.webpVP8L(640, 480)))
        assertEquals(PixelSize(320, 240), PhotoEdit.size(PhotoHeaders.webpVP8(320, 240)))
        assertNull(PhotoEdit.size("data:image/png;base64,x"))
        assertNull(PhotoEdit.size(PhotoHeaders.png(0, 10)))
        assertNull(PhotoEdit.size("not a data url"))
    }

    @Test fun takesPngJpegAndWebPOnly() {
        assertTrue(PhotoEdit.accepts(PhotoHeaders.png(1, 1)))
        assertTrue(PhotoEdit.accepts(PhotoHeaders.jpeg(1, 1)))
        assertTrue(PhotoEdit.accepts(PhotoHeaders.webpVP8X(1, 1)))
        for (bad in listOf("data:image/gif;base64,R0lG", "data:image/heic;base64,AAAA", "https://example.com/a.png", "data:image/PNG;base64,AAAA",
            "data:image/png;base64,", "data:image/png;base64,AA AA", "data:image/png;base64,AA\nAA", "data:image/png;base64,AA-_",
            "data:image/png;base64,A===", "data:image/png;base64,==")) assertFalse(bad, PhotoEdit.accepts(bad))
        assertTrue(PhotoEdit.accepts("data:image/png;base64,AA=="))
        assertTrue(PhotoEdit.accepts("data:image/jpeg;base64,ab+/9Z=="))
    }

    @Test fun allPhotosTogetherFitSixMiB() {
        val prefix = "data:image/jpeg;base64,"
        val half = prefix + "A".repeat(PhotoEdit.MAX_TOTAL_CHARS / 2 - prefix.length)
        assertTrue(PhotoEdit.fitsTotal(listOf(half, half)))
        assertFalse(PhotoEdit.fitsTotal(listOf(half, half + "A")))
        assertTrue(PhotoEdit.fitsTotal(emptyList()))
    }

    @Test fun generatedPictureKnowsAClip() {
        fun j(s: String) = WireJson.parseToJsonElement(s)
        assertEquals(false, GeneratedPicture.from(j("""{"modelId":"m","width":1024,"height":768}"""))?.isClip)
        assertEquals(true, GeneratedPicture.from(j("""{"modelId":"m","video":{"frames":49,"fps":16}}"""))?.isClip)
        assertEquals(false, GeneratedPicture.from(j("""{"modelId":"m","video":null}"""))?.isClip)
        assertNull(GeneratedPicture.from(null))
        assertNotNull(ChatMessage.from(j("""{"id":"a","role":"assistant","images":["data:image/png;base64,x"],"generated":{"modelId":"m"}}"""))?.generated)
        assertNull(ChatMessage.from(j("""{"id":"u","role":"user","generated":{"modelId":"m"}}"""))?.generated)
    }

    @Test fun anEditSendsThePhotosAndTheFirstOnesShape() {
        val params = ImageChatParams(modelId = "flux", width = 1024.0, height = 1024.0)
        val r = params.generation("s1", "Make the sky purple", listOf(PhotoHeaders.jpeg(3024, 4032), PhotoHeaders.png(10, 10)))
        assertEquals(2, (r["images"] as kotlinx.serialization.json.JsonArray).size)
        assertEquals("""{"width":896,"height":1152}""", r["size"].toString())
        assertNull(params.generation("s1", "A cat")["images"])
        // At most four go.
        assertEquals(4, (params.generation("s1", "x", List(6) { PhotoHeaders.png(1, 1) })["images"] as kotlinx.serialization.json.JsonArray).size)
    }
}
