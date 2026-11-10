package com.nekko.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ImageChatTest {
    private fun json(s: String) = WireJson.parseToJsonElement(s)

    @Test fun `image models drop non-image rows and private fields`() {
        val models = ImageChatModel.list(json("""[{"id":"i","name":"Flux","kind":"image","format":"gguf","state":"ready","path":"/secret/model","token":"secret"},{"id":"t","kind":"chat"},{"kind":"image"}]"""))
        assertEquals(listOf(ImageChatModel("i", "Flux", "image", "gguf", "ready")), models)
        assertFalse(models.toString().contains("secret"))
    }

    @Test fun `new defaults and generation payload are integer signable`() {
        val p = ImageChatParams("flux")
        assertEquals(4.0, p.cfgScale, 0.0)
        val opts = p.sessionOptions()
        assertEquals("image", opts["chatType"]!!.jsonPrimitive.content)
        assertEquals(p, ImageChatParams.from(opts["imageParams"]))
        val request = p.generation("s", "A cat")
        assertEquals(setOf("sessionId", "prompt", "params"), request.keys)
        assertTrue(ChangeProof.canonicalJson(JsonArray(listOf(request))).contains("\"cfgScale\":4"))
        assertTrue(Channels.CHAT_GENERATE_IMAGE in Channels.CHANGE)
        assertTrue(Channels.ENGINE_MODELS in Channels.ALL)
        assertTrue(Channels.SESSION_PHOTO in Channels.ALL)
    }

    @Test fun `fractional saved values are preserved but never rounded or signed`() {
        val p = ImageChatParams.from(json("""{"cfgScale":4.5,"width":768.5}"""))!!
        assertEquals(4.5, p.cfgScale, 0.0)
        assertEquals(768.5, p.width, 0.0)
        assertFalse(p.valid)
        assertTrue(runCatching { p.json() }.exceptionOrNull() is IllegalArgumentException)
        assertFalse(ImageChatParams.from(json("{}"))!!.valid)
        assertFalse(ImageChatParams.from(json("""{"cfgScale":"4"}"""))!!.valid)
    }

    @Test fun `parameter boundaries reject invalid numbers`() {
        listOf(ImageChatParams(width = 255.0), ImageChatParams(height = 2049.0), ImageChatParams(width = 513.0),
            ImageChatParams(steps = 0.0), ImageChatParams(steps = 101.0), ImageChatParams(cfgScale = 30.5),
            ImageChatParams(seed = -2.0), ImageChatParams(seed = 2147483648.0), ImageChatParams(cfgScale = Double.NaN)).forEach { assertFalse(it.valid) }
        assertTrue(ImageChatParams(width = 256.0, height = 2048.0, steps = 100.0, cfgScale = 30.0, seed = 2147483647.0).valid)
    }

    @Test fun `capability must be explicitly advertised`() {
        assertFalse(AppInfo.from(null).imageGeneration)
        assertFalse(AppInfo.from(json("""{"imageGeneration":true}""")).imageGeneration)
        assertTrue(AppInfo.from(json("""{"capabilities":{"imageGeneration":true}}""")).imageGeneration)
    }

    @Test fun `attachment-only assistant replies survive projection`() {
        val session = Session.from(json("""{"id":"s","chatType":"image","imageParams":{"modelId":"f","cfgScale":4},"messages":[{"id":"a","role":"assistant","content":"","images":["data:image/png;base64,AA==",""]}]}"""))!!
        val reply = Transcript.fromMessages(session.messages).single() as Block.Assistant
        assertEquals(2, reply.thumbs.size)
        assertEquals("", reply.text)
        assertFalse(session.canOfferSubagent("parallel"))
        assertEquals("image", session.chatType)
        assertEquals("f", session.imageParams!!.modelId)
    }

    @Test fun `host image status starts live turn and activity until terminal event`() {
        for (stage in listOf("loading", "generating")) {
            val event = AgentEvent.from(json("""{"type":"image_status","sessionId":"s","stage":"$stage","label":"Working"}"""))!!
            val turn = Transcript.apply(LiveTurn(), event)
            assertTrue(turn.running)
            assertTrue(turn.blocks.isEmpty())
            assertEquals(Activity.RUNNING, ActivityTracker.next(emptyMap(), event)["s"])
            for (end in listOf(AgentEvent.Done("s", null), AgentEvent.Error("s", "Failed"))) {
                assertFalse(Transcript.apply(turn, end).running)
                assertFalse(ActivityTracker.next(mapOf("s" to Activity.RUNNING), end).containsKey("s"))
            }
        }
        assertFalse(Transcript.apply(LiveTurn(), AgentEvent.Other("s", "future_event")).running)
        assertTrue(ActivityTracker.next(emptyMap(), AgentEvent.Other("s", "future_event")).isEmpty())
    }

    @Test fun `offline copy preserves image intent and fractional settings but no image data`() {
        val s = Session.from(json("""{"id":"s","chatType":"image","imageParams":{"modelId":"f","cfgScale":4.5},"messages":[{"id":"a","role":"assistant","content":"","images":["data:image/png;base64,secret"]}]}"""))!!
        val encoded = SavedTranscript(42, s).json()
        assertFalse(encoded.toString().contains("secret"))
        val copy = SavedTranscript.from(encoded)!!.session
        assertEquals("image", copy.chatType)
        assertEquals(4.5, copy.imageParams!!.cfgScale, 0.0)
        assertFalse(copy.imageParams!!.valid)
        assertEquals(listOf(""), (Transcript.fromMessages(copy.messages).single() as Block.Assistant).thumbs)
        val summary = SessionSummary.from(json("""{"id":"s","chatType":"image","imageParams":{"cfgScale":4}}"""))!!
        assertEquals("image", SavedChatList.from(SavedChatList(42, listOf(summary), emptyList()).json())!!.summaries.single().chatType)
    }
}
