package com.nekko.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Photos in chats that run on this phone (#2926), as the iPhone's PhoneChatPhotosTests. */
class PhoneChatPhotosTest {
    private val jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    private val png = "data:image/png;base64,iVBORw0KGgo="
    private fun provider(kind: String) = PhoneProviders.make("p", kind, "API", PhoneProviders.kind(kind)!!.defaultUrl.takeUnless { it.contains("YOUR_") || it == "https://" } ?: "https://api.example.com/base", "secret")
    private fun messages(req: PhoneRequest) = req.body!!["messages"]!!.jsonArray
    private fun JsonElement.type() = jsonObject["type"]!!.jsonPrimitive.content

    @Test fun claudeGetsImageBlocksBeforeTheText() {
        val req = PhoneProviders.chatRequest(provider("anthropic"), "k", "claude-opus-5-5", listOf(PhoneMessage("1", "user", "What is this?", 1, images = listOf(jpeg, png))))
        val parts = messages(req).first().jsonObject["content"]!!.jsonArray
        assertEquals(listOf("image", "image", "text"), parts.map { it.type() })
        val source = parts[0].jsonObject["source"]!!.jsonObject
        assertEquals("base64", source["type"]!!.jsonPrimitive.content)
        assertEquals("image/jpeg", source["media_type"]!!.jsonPrimitive.content)
        assertEquals("/9j/4AAQSkZJRg==", source["data"]!!.jsonPrimitive.content)
        assertEquals("image/png", parts[1].jsonObject["source"]!!.jsonObject["media_type"]!!.jsonPrimitive.content)
    }

    @Test fun openAiRouteGetsImageUrlPartsAfterTheText() {
        for (kind in listOf("openai", "openrouter", "gemini", "ollama-cloud")) {
            val req = PhoneProviders.chatRequest(provider(kind), "k", "m", listOf(PhoneMessage("1", "user", "Describe", 1, images = listOf(jpeg))))
            val parts = messages(req).last().jsonObject["content"]!!.jsonArray
            assertEquals(kind, listOf("text", "image_url"), parts.map { it.type() })
            assertEquals(kind, jpeg, parts[1].jsonObject["image_url"]!!.jsonObject["url"]!!.jsonPrimitive.content)
        }
    }

    @Test fun textTurnsStayStringsAndPhotoOnlyTurnsHaveNoTextPart() {
        val msgs = listOf(PhoneMessage("1", "user", "Hi", 1), PhoneMessage("2", "assistant", "Hello", 2), PhoneMessage("3", "user", "", 3, images = listOf(png)))
        val turns = messages(PhoneProviders.chatRequest(provider("openai"), "k", "gpt-5", msgs))
        assertEquals(4, turns.size)
        assertEquals("Hi", turns[1].jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals(listOf("image_url"), turns[3].jsonObject["content"]!!.jsonArray.map { it.type() })
        val claude = messages(PhoneProviders.chatRequest(provider("anthropic"), "k", "claude-opus-5-5", msgs))
        assertEquals("Claude refuses an empty text block", listOf("image"), claude.last().jsonObject["content"]!!.jsonArray.map { it.type() })
    }

    @Test fun onlyImageDataUrlsAreSent() {
        assertNotNull(PhoneProviders.imagePart(jpeg))
        assertEquals("image/webp", PhoneProviders.imagePart("data:image/webp;base64,UklGRg==")?.mediaType)
        assertNull("no remote URL is fetched on the user's behalf", PhoneProviders.imagePart("https://example.com/cat.jpg"))
        assertNull(PhoneProviders.imagePart("data:image/svg+xml;base64,PHN2Zz4="))
        assertNull(PhoneProviders.imagePart("data:image/jpeg;base64,"))
        assertNull(PhoneProviders.imagePart("data:image/jpeg;base64,abc\"}"))
        assertNull(PhoneProviders.imagePart("data:image/jpeg;base64," + "A".repeat(PhoneProviders.MAX_IMAGE_CHARS)))
    }

    @Test fun chatsSavedBeforePhotosStillLoad() {
        val m = Json.decodeFromString<PhoneMessage>("""{"id":"1","role":"user","text":"Hi","at":1}""")
        assertNull(m.images)
        assertFalse(Json.encodeToString(PhoneMessage.serializer(), m).contains("images"))
    }

    @Test fun whichModelsTakePhotos() {
        val router = """{"data":[{"id":"a/vision","architecture":{"input_modalities":["text","image"]}},{"id":"b/text","architecture":{"input_modalities":["text"]}},{"id":"c/unknown"}]}"""
        assertEquals(listOf(true, false, null), PhoneProviders.models(router, "openrouter").map { it.acceptsImages })
        assertEquals(true, PhoneProviders.models("""{"data":[{"id":"claude-opus-5-5"}]}""", "anthropic").single().acceptsImages)
        assertNull("OpenAI's list doesn't say", PhoneProviders.models("""{"data":[{"id":"gpt-5"}]}""", "openai").single().acceptsImages)
    }
}
