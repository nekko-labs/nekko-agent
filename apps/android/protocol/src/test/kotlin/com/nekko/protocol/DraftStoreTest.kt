package com.nekko.protocol

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryOfflineFiles : OfflineFiles {
    val files = HashMap<Pair<String, String>, JsonElement>()
    var saves = 0
    override fun load(computerId: String, name: String) = files[computerId to name]
    override fun save(computerId: String, name: String, value: JsonElement) { files[computerId to name] = value; saves++ }
    override fun remove(computerId: String) { files.keys.removeAll { it.first == computerId } }
}

@OptIn(ExperimentalCoroutinesApi::class)
class DraftStoreTest {
    private val skill = SkillSummary("plan", "Plan it", "Planning", "builtin")

    @Test fun `a draft round-trips, the skill without its instructions`() {
        val d = Draft("Fix the build", skill, listOf("data:image/jpeg;base64,AAAA"), providerId = "p", modelId = "m", refusal = "No model")
        assertEquals(d, Draft.from(d.json()))
        assertFalse(d.json().toString().contains("template"))
    }

    @Test fun `empty and content`() {
        assertTrue(Draft().isEmpty)
        assertTrue(Draft(text = "  \n").isEmpty)
        assertFalse(Draft(modelId = "m").isEmpty)
        assertFalse(Draft(modelId = "m").hasContent)
        assertTrue(Draft(images = listOf("x")).hasContent)
    }

    @Test fun `what comes back goes in front of what is typed, and nothing is lost`() {
        val now = Draft("and also this", images = listOf("b", "c", "d"))
        val back = Draft("the refused prompt", skill, listOf("a", "z"), refusal = "Chat deleted")
        val m = now.merging(back)
        assertEquals("the refused prompt\n\nand also this", m.text)
        assertEquals(skill, m.skill)
        assertEquals(listOf("a", "z", "b", "c"), m.images)
        assertEquals("Chat deleted", m.refusal)
        assertEquals("the refused prompt", Draft().merging(back).text)
    }

    @Test fun `typing is saved after a pause, clearing at once, per computer`() = runTest {
        val files = MemoryOfflineFiles()
        val store = DraftStore(files, backgroundScope, debounceMs = 500)
        store.load("c1")
        store.set("s1", Draft("hel"))
        store.set("s1", Draft("hello"))
        runCurrent()
        assertNull("not yet", files.files["c1" to "drafts"])
        advanceTimeBy(501)
        runCurrent()
        assertEquals(1, files.saves)

        // Another computer: the first one's drafts stay in its file, the second starts empty.
        store.load("c2")
        assertTrue(store.drafts.value.isEmpty())
        store.load("c1")
        assertEquals("hello", store.draft("s1").text)

        store.clear("s1")
        assertTrue(store.drafts.value.isEmpty())
        assertEquals("""{}""", (files.files["c1" to "drafts"] as kotlinx.serialization.json.JsonObject)["drafts"].toString())
    }

    @Test fun `an empty draft is dropped, hand back and move merge`() = runTest {
        val store = DraftStore(MemoryOfflineFiles(), backgroundScope, debounceMs = 0)
        store.load("c1")
        store.set("s1", Draft("x"))
        store.set("s1", Draft(""))
        assertTrue(store.drafts.value.isEmpty())
        store.set("new", Draft("typed"))
        store.handBack("new", Draft("refused", refusal = "No model"))
        assertEquals("refused\n\ntyped", store.draft("new").text)
        store.move("new", "s9")
        assertEquals("refused\n\ntyped", store.draft("s9").text)
        assertTrue("new" !in store.drafts.value)
    }

    @Test fun `a file of another version is ignored, not misread`() = runTest {
        val files = MemoryOfflineFiles()
        files.files["c1" to "drafts"] = buildJsonObject {
            put("v", 2)
            put("drafts", buildJsonObject { put("s1", buildJsonObject { put("text", "hi") }) })
        }
        val store = DraftStore(files, backgroundScope)
        store.load("c1")
        assertTrue(store.drafts.value.isEmpty())
    }

    @Test fun `prompts carry their clientMessageId, the session lists the ids it took`() {
        val opts = sendOptions("s1", "p", "m", "hi", clientMessageId = "id-1")
        assertEquals("id-1", (opts["clientMessageId"] as JsonPrimitive).content)
        assertEquals(JsonPrimitive("plain"), queuePrompt("plain"))
        assertEquals("""{"text":"hi","clientMessageId":"id-1"}""", queuePrompt("hi", clientMessageId = "id-1").toString())
        val s = Session.from(WireJson.parseToJsonElement("""{"id":"s1","messages":[],"clientMessageIds":["a","b",3],"activeRun":{"id":"r"}}"""))!!
        assertEquals(listOf("a", "b"), s.clientMessageIds)
        assertTrue(s.running)
        assertFalse(Session.from(WireJson.parseToJsonElement("""{"id":"s1","messages":[],"activeRun":null}"""))!!.running)
    }

    @Test fun `only the computer refusing the id counts as an older computer`() {
        assertTrue(RelayException("x", PhoneRefusal("option-denied", "clientMessageId")).refusedClientMessageId)
        assertTrue(RelayException("Unknown key clientMessageId", fromComputer = true).refusedClientMessageId)
        assertFalse("lost on the way", RelayException("clientMessageId timed out", afterSend = true).refusedClientMessageId)
        assertFalse(RelayException("No such chat", fromComputer = true).refusedClientMessageId)
    }
}
