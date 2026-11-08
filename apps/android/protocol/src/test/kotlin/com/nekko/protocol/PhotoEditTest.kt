package com.nekko.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

/** Photo editing in image chats (#2230, decision 0069): the desktop's photoEdit.ts on Android. */
class PhotoEditTest {
    private fun json(s: String) = WireJson.parseToJsonElement(s)
    private fun url(type: String, bytes: ByteArray) = "data:$type;base64," + Base64.getEncoder().encodeToString(bytes)
    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    private fun png(w: Int, h: Int) = url("image/png", bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        w ushr 24, (w ushr 16) and 0xFF, (w ushr 8) and 0xFF, w and 0xFF, h ushr 24, (h ushr 16) and 0xFF, (h ushr 8) and 0xFF, h and 0xFF, 8, 2, 0, 0, 0))

    // SOI, an APP0 segment to skip, then SOF0: precision, height, width.
    private fun jpeg(w: Int, h: Int) = url("image/jpeg", bytes(0xFF, 0xD8, 0xFF, 0xE0, 0, 6, 0x4A, 0x46, 0x49, 0x46,
        0xFF, 0xC0, 0, 17, 8, h shr 8, h and 0xFF, w shr 8, w and 0xFF, 3, 0, 0, 0, 0, 0, 0))

    private fun webp(w: Int, h: Int): String {
        val b = ByteArray(30)
        "RIFF".toByteArray().copyInto(b, 0); "WEBP".toByteArray().copyInto(b, 8); "VP8X".toByteArray().copyInto(b, 12)
        for (i in 0..2) { b[24 + i] = (((w - 1) shr (8 * i)) and 0xFF).toByte(); b[27 + i] = (((h - 1) shr (8 * i)) and 0xFF).toByte() }
        return url("image/webp", b)
    }

    @Test fun `edit size matches the desktop's editSize exactly`() {
        val chosen = 1024L to 1024L
        // The same cases as photoEditing.test.tsx.
        assertEquals(896L to 1152L, PhotoEdit.editSize(3024 to 4032, chosen))
        assertEquals(1344L to 768L, PhotoEdit.editSize(1920 to 1080, chosen))
        assertEquals(chosen, PhotoEdit.editSize(500 to 500, chosen))
        assertEquals(2048L to 256L, PhotoEdit.editSize(10000 to 100, chosen))
        assertSame(chosen, PhotoEdit.editSize(0 to 0, chosen))
        // The chat's pixel count, not its shape: a 768×1024 chat edits a landscape photo landscape.
        assertEquals(1024L to 768L, PhotoEdit.editSize(4000 to 3000, 768L to 1024L))
        for (w in listOf(1, 37, 640, 1080, 4032, 9999)) for (h in listOf(1, 480, 1920, 7000)) {
            val (ew, eh) = PhotoEdit.editSize(w to h, 1024L to 768L)
            assertTrue(ew in 256..2048 && eh in 256..2048 && ew % 64 == 0L && eh % 64 == 0L)
        }
    }

    @Test fun `photos fit within 1536 px and are never enlarged`() {
        assertEquals(1536 to 1152, PhotoEdit.fit(4032, 3024))
        assertEquals(1152 to 1536, PhotoEdit.fit(3024, 4032))
        assertEquals(800 to 600, PhotoEdit.fit(800, 600))
    }

    @Test fun `pixel size is read from PNG JPEG and WebP headers`() {
        assertEquals(3024 to 4032, PhotoEdit.size(png(3024, 4032)))
        assertEquals(1920 to 1080, PhotoEdit.size(jpeg(1920, 1080)))
        assertEquals(640 to 480, PhotoEdit.size(webp(640, 480)))
        assertNull(PhotoEdit.size("data:image/png;base64,AA=="))
        assertNull(PhotoEdit.size("not a data url"))
        assertTrue(PhotoEdit.attachAsIs(png(1024, 1024)))
        assertFalse(PhotoEdit.attachAsIs(png(2048, 1024)))
        assertFalse(PhotoEdit.attachAsIs(url("image/gif", bytes(0x47, 0x49, 0x46))))
    }

    @Test fun `payload carries images and size only with photos`() {
        val p = ImageChatParams("flux", width = 1024.0, height = 1024.0)
        val plain = p.generation("s", "A cat")
        assertEquals(setOf("sessionId", "prompt", "params"), plain.keys)
        assertEquals(plain, p.generation("s", "A cat", emptyList()))

        val photos = listOf(jpeg(3024, 4032), png(512, 512))
        val edit = p.generation("s", "Make it night", photos)
        assertEquals(setOf("sessionId", "prompt", "params", "images", "size"), edit.keys)
        assertEquals(photos, edit["images"]!!.jsonArray.map { it.jsonPrimitive.content })
        // The first photo's shape at the chat's pixel count; params keep the chat's own size.
        assertEquals(json("""{"width":896,"height":1152}"""), edit["size"])
        assertEquals(plain["params"], edit["params"])
        // Integers only, so the Change proof can sign the exact request.
        assertTrue(ChangeProof.canonicalJson(JsonArray(listOf(edit))).contains("\"size\":{\"height\":1152,\"width\":896}"))

        // An unreadable first photo: the chat's own size.
        assertEquals(json("""{"width":1024,"height":1024}"""), p.generation("s", "x", listOf("data:image/png;base64,AA=="))["size"])
    }

    @Test fun `payload refuses more than 4 photos or other types`() {
        val p = ImageChatParams("flux")
        assertEquals(4, p.generation("s", "x", List(4) { png(64, 64) })["images"]!!.jsonArray.size)
        assertEquals(PhotoEdit.TOO_MANY, runCatching { p.generation("s", "x", List(5) { png(64, 64) }) }.exceptionOrNull()?.message)
        for (bad in listOf("data:image/gif;base64,R0lG", "https://example.com/a.png", "data:image/png,raw", "data:image/png;base64,",
            "data:image/PNG;base64,AA==", "data:image/png;base64,AA\n==", "data:image/png;base64,A-_A", "data:image/png;base64,AA===", "data:image/png;base64,==")) {
            assertEquals(bad, PhotoEdit.WRONG_TYPE, runCatching { p.generation("s", "x", listOf(bad)) }.exceptionOrNull()?.message)
        }
        assertTrue(PhotoEdit.accepts("data:image/webp;base64,UklGRg=="))
        assertTrue(PhotoEdit.accepts("data:image/jpeg;base64,/9j/4A+"))
    }

    @Test fun `all photos together stay within 6 MiB of data URL characters`() {
        val p = ImageChatParams("flux")
        val prefix = "data:image/jpeg;base64,"
        val half = prefix + "A".repeat(PhotoEdit.MAX_TOTAL_CHARS / 2 - prefix.length)
        assertEquals(2, p.generation("s", "x", listOf(half, half))["images"]!!.jsonArray.size)
        assertEquals(PhotoEdit.TOO_LARGE, runCatching { p.generation("s", "x", listOf(half, half + "AAAA")) }.exceptionOrNull()?.message)
    }

    @Test fun `only a made picture that is not a clip is editable`() {
        fun reply(generated: String?) = Transcript.fromMessages(Session.from(json(
            """{"id":"s","chatType":"image","messages":[{"id":"a","role":"assistant","content":"","images":["data:image/png;base64,AA=="]${generated?.let { ",\"generated\":$it" } ?: ""}}]}""",
        ))!!.messages).single() as Block.Assistant
        assertTrue(reply("""{"modelId":"flux","width":1024,"height":1024,"seed":1,"ms":10}""").editable)
        assertFalse(reply("""{"modelId":"wan","video":{"frames":33,"fps":16}}""").editable)
        assertTrue(reply("""{"modelId":"flux","video":null}""").editable)
        assertFalse(reply(null).editable)
        // A prompt's photos are never "generated".
        val user = ChatMessage.from(json("""{"id":"u","role":"user","content":"x","generated":{"modelId":"flux"}}"""))!!
        assertNull(user.generated)
        assertEquals(GeneratedImage("wan", video = true), GeneratedImage.from(json("""{"modelId":"wan","video":{"frames":33,"fps":16}}""")))
    }
}
