package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SavedTranscriptsTest {
    private class Files : OfflineFiles {
        val map = LinkedHashMap<String, JsonElement>()
        var writes = 0
        override fun load(computerId: String, name: String) = map["$computerId/$name"]
        override fun save(computerId: String, name: String, value: JsonElement) { map["$computerId/$name"] = value; writes++ }
        override fun remove(computerId: String) { map.keys.removeAll { it.startsWith("$computerId/") } }
        override fun removeFile(computerId: String, name: String) { map.remove("$computerId/$name") }
        fun chatFiles() = map.keys.filter { it.contains("/chat-") }
    }

    private var clock = 1_000L

    private fun session(id: String, vararg texts: String, images: List<String> = emptyList()) = Session(
        id = id, title = "Chat $id", providerId = "p", modelId = "m", workspaceId = "w", queue = listOf("queued"), updatedAt = 5,
        mode = PcSettings.ChatMode.ASK, clientMessageIds = listOf("x"), running = true,
        messages = texts.mapIndexed { i, t -> ChatMessage("$id-$i", if (i % 2 == 0) "user" else "assistant", t, images = if (i == 0) images else emptyList()) },
    )

    private fun store(files: Files, maxChats: Int = 20, maxBytes: Int = 5_000_000, maxChatBytes: Int = 1_000_000) =
        SavedTranscripts(maxChats, maxBytes, maxChatBytes) { clock++ }.apply { use(files, "c1") }

    @Test fun `a chat is kept as the phone shows it, without photos, the queue or what only the computer knows`() {
        val files = Files()
        val s = store(files)
        s.save(session("a", "look at this", "a cat", images = listOf("data:image/jpeg;base64,AAAA", "")))
        val copy = s.saved("a")!!
        assertEquals(listOf("look at this", "a cat"), copy.session.messages.map { it.content })
        assertEquals(listOf("", ""), copy.session.messages[0].images)
        assertEquals(PcSettings.ChatMode.ASK, copy.session.mode)
        assertTrue(copy.session.queue.isEmpty())
        assertTrue(copy.session.clientMessageIds.isEmpty())
        assertFalse(copy.session.running)
        assertFalse(files.map.values.any { it.toString().contains("base64") })
        // Another start reads the same.
        assertEquals("a cat", store(files).saved("a")!!.session.messages[1].content)
    }

    @Test fun `the last opened stay, by count and by size, least recent out first`() {
        val files = Files()
        val s = store(files, maxChats = 2)
        s.save(session("a", "1"))
        s.save(session("b", "2"))
        s.touch("a")
        s.save(session("c", "3"))
        assertEquals(listOf("c", "a"), s.chatIds)
        assertEquals(2, files.chatFiles().size)
        assertNull(s.saved("b"))

        val big = Files()
        val one = store(big).also { it.save(session("a", "x".repeat(300))) }.totalBytes
        val t = store(big, maxBytes = one * 2 - 1)
        t.save(session("b", "x".repeat(300)))
        assertEquals(listOf("b"), t.chatIds)
    }

    @Test fun `a long chat keeps its newest messages and counts the rest`() {
        val s = store(Files(), maxChatBytes = 2_000)
        s.save(session("a", *Array(40) { "message $it ".repeat(5) }))
        val copy = s.saved("a")!!.session
        assertTrue(copy.messages.size < 40)
        assertEquals("message 39 ".repeat(5), copy.messages.last().content)
        assertEquals(40, copy.messages.size + copy.omittedMessages)
    }

    @Test fun `a single message bigger than a chat may be means no copy, not a misleading part`() {
        val s = store(Files(), maxChatBytes = 500)
        s.save(session("a", "short"))
        assertNotNull(s.saved("a"))
        s.save(session("a", "y".repeat(2_000)))
        assertNull(s.saved("a"))
    }

    @Test fun `the same chat again only moves it, a changed one is written`() {
        val files = Files()
        val s = store(files)
        s.save(session("a", "1"))
        val chatWrites = { files.writes }
        val before = chatWrites()
        s.save(session("a", "1"))
        assertEquals("the index only", before + 1, chatWrites())
        s.save(session("a", "1", "2"))
        assertEquals(before + 3, chatWrites())
    }

    @Test fun `chats the computer no longer has, or deleted here, go, and other versions are ignored`() {
        val files = Files()
        val s = store(files)
        s.save(session("a", "1"))
        s.save(session("b", "2"))
        s.keepOnly(setOf("b"))
        assertEquals(listOf("b"), s.chatIds)
        s.remove("b")
        assertTrue(files.chatFiles().isEmpty())

        s.save(session("c", "3"))
        val key = files.map.keys.first { it.contains("/chat-") }
        files.map[key] = WireJson.parseToJsonElement(files.map[key].toString().replace("\"v\":1", "\"v\":2"))
        assertNull(s.saved("c"))
    }

    @Test fun `nothing is kept while the setting is off`() {
        val s = SavedTranscripts { clock++ }
        s.use(null, "c1")
        s.save(session("a", "1"))
        assertNull(s.saved("a"))
        assertTrue(s.chatIds.isEmpty())
    }

    @Test fun `a saved message reads back the image count only`() {
        val m = ChatMessage("m", "user", "hi", images = listOf("data:x", "data:y"))
        val back = ChatMessage.from(m.savedJson())!!
        assertEquals(listOf("", ""), back.images)
        assertFalse((m.savedJson() as JsonObject).containsKey("images"))
    }
}
