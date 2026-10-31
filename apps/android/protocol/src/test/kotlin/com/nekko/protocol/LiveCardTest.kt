package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The card's rules, held to the iPhone's LiveCardTests and the shared fixture the computer runs too. */
class LiveCardTest {
    private val now = 100_000.0

    private fun chat(id: String, state: LiveChatState, finished: Double? = null, short: String = "T", step: String = "S", reply: String = "R") =
        LiveChat(id, short, state, step, reply, "Cool", finishedAt = finished?.let { now - it })

    private fun build(chats: List<LiveChat>, previous: LiveCardState? = null, pinned: String? = null, level: LiveLevel = LiveLevel.DETAILED) =
        LiveCard.build(chats, previous, pinned, level, now)

    @Test fun `sorts by state then most recent`() {
        val card = build(
            listOf(
                chat("f", LiveChatState.FAILED, 60.0), chat("d-old", LiveChatState.DONE, 600.0), chat("d-new", LiveChatState.DONE, 60.0),
                chat("w", LiveChatState.WATCHING), chat("r", LiveChatState.WORKING), chat("n", LiveChatState.NEEDS_YOU),
            ),
        )!!
        assertEquals(listOf("n", "r", "w", "d-new", "d-old", "f"), card.chats.map { it.id })
        assertEquals("n", card.focusId)
    }

    @Test fun `clips the step and keeps the reply`() {
        val card = build(listOf(chat("a", LiveChatState.WORKING, step = "x".repeat(200), reply = "Done.")))!!
        assertEquals(60, card.chats[0].step.length)
        assertEquals("Done.", card.chats[0].reply)
    }

    @Test fun `keeps eight and counts the rest`() {
        val card = build((0 until 10).map { chat("c$it", LiveChatState.WORKING) })!!
        assertEquals(8, card.chats.size)
        assertEquals(2, card.more)
    }

    @Test fun `drops old finished chats`() {
        val card = build(listOf(chat("old", LiveChatState.DONE, 2 * 3600.0 + 60), chat("older", LiveChatState.FAILED, 5 * 3600.0), chat("ok", LiveChatState.DONE, 2 * 3600.0 - 60)))!!
        assertEquals(listOf("ok"), card.chats.map { it.id })
        assertEquals(0, card.more)
    }

    @Test fun `nothing left or level none is no card`() {
        assertNull(build(emptyList()))
        assertNull(build(listOf(chat("old", LiveChatState.DONE, 3 * 3600.0))))
        assertNull(build(listOf(chat("a", LiveChatState.WORKING)), level = LiveLevel.NONE))
    }

    @Test fun `focus defaults to the first and keeps a pin`() {
        val chats = listOf(chat("a", LiveChatState.WORKING), chat("b", LiveChatState.WORKING), chat("c", LiveChatState.WATCHING))
        assertEquals("a", build(chats)!!.focusId)
        assertEquals("c", build(chats, pinned = "c")!!.focusId)
        assertEquals("a", build(chats, pinned = "gone")!!.focusId)
    }

    @Test fun `focus jumps to a chat that newly needs you, over the pin`() {
        val before = build(listOf(chat("a", LiveChatState.WORKING), chat("b", LiveChatState.WORKING)), pinned = "b")!!
        val after = build(listOf(chat("a", LiveChatState.WORKING), chat("b", LiveChatState.NEEDS_YOU)), previous = before, pinned = "a")!!
        assertEquals("b", after.focusId)
        // Already needed you last time: not new, so the pin wins.
        val again = build(listOf(chat("a", LiveChatState.WORKING), chat("b", LiveChatState.NEEDS_YOU)), previous = after, pinned = "a")!!
        assertEquals("a", again.focusId)
        val fresh = build(listOf(chat("a", LiveChatState.WORKING), chat("z", LiveChatState.NEEDS_YOU)), previous = build(listOf(chat("a", LiveChatState.WORKING))), pinned = "a")!!
        assertEquals("z", fresh.focusId)
    }

    @Test fun `levels blank the text`() {
        val chats = listOf(chat("a", LiveChatState.WORKING, short = "Fix", step = "Run tests", reply = "Got it"))
        val minimal = build(chats, level = LiveLevel.MINIMAL)!!.chats[0]
        assertEquals(listOf("", "", ""), listOf(minimal.short, minimal.step, minimal.reply))
        assertEquals("Cool", minimal.closeWord)
        val standard = build(chats, level = LiveLevel.STANDARD)!!.chats[0]
        assertEquals(listOf("Fix", "Run tests", ""), listOf(standard.short, standard.step, standard.reply))
        assertEquals("Got it", build(chats, level = LiveLevel.DETAILED)!!.chats[0].reply)
    }

    @Test fun `short titles, close words and reply lines`() {
        assertEquals("Fix", LiveCard.shortTitle("Fix login bug"))
        assertEquals("Fix it", LiveCard.shortTitle("Fix it now"))
        assertEquals("Refactor…", LiveCard.shortTitle("Refactoring the parser"))
        assertEquals("Deploy", LiveCard.shortTitle("  Deploy  "))
        assertEquals("", LiveCard.shortTitle(""))
        assertEquals("Got it", LiveCard.closeWord("chat-1", failed = true))
        assertEquals("Excellent", LiveCard.closeWord("chat-1", failed = false))
        assertTrue((0 until 50).map { LiveCard.closeWord("c$it", false) }.toSet().size > 1)
        assertEquals("Got it.", LiveCard.replyLine("Got it. Working on it now."))
        assertEquals("Done!", LiveCard.replyLine("  Done!\nThe tests pass."))
        assertEquals("Version 1.2 is out", LiveCard.replyLine("Version 1.2 is out"))
        assertEquals("", LiveCard.replyLine(null))
        val long = LiveCard.replyLine("word ".repeat(30))
        assertEquals(60, long.length)
        assertTrue(long.endsWith("…"))
    }

    @Test fun `unknown states read as working and missing fields as empty`() {
        val s = LiveCardState.from(Json.parseToJsonElement("""{"chats":[{"id":"a","state":"sleeping"},{"id":"b","state":"done"}]}"""))
        assertEquals(listOf(LiveChatState.WORKING, LiveChatState.DONE), s.chats.map { it.state })
        assertEquals(LiveCardState(emptyList(), null), LiveCardState.from(Json.parseToJsonElement("{}")))
    }

    /**
     * The shared rules (packages/shared/fixtures/live-card.json). Three cases test
     * ActivityKit's 4 KB guard (counted as Swift's encoder writes bytes), which
     * an Android notification doesn't have, so they and the byte counts are skipped.
     */
    @Test fun `the shared fixture`() {
        val root = Json.parseToJsonElement(File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "packages/shared/fixtures/live-card.json").readText()) as JsonObject
        val fixtureNow = (root["now"] as JsonPrimitive).double
        val sizeGuard = setOf(
            "a big card blanks every reply first",
            "a huge card then moves the last chats into more, never the focused one",
            "a slash counts as two bytes, as Swift's JSONEncoder writes it",
        )
        var ran = 0
        for (c in root["build"] as JsonArray) {
            val o = c as JsonObject
            val name = (o["name"] as JsonPrimitive).content
            if (name in sizeGuard) continue
            val chats = (o["chats"] as? JsonArray).orEmpty().mapNotNull { LiveChat.from(it) }
            val previous = o["previous"]?.takeIf { it !is JsonNull }?.let { LiveCardState.from(it) }
            val level = LiveLevel.parse((o["level"] as JsonPrimitive).content)!!
            val pinned = (o["pinnedFocus"] as? JsonPrimitive)?.contentOrNull
            val want = o["card"]?.takeIf { it !is JsonNull }?.let { LiveCardState.from(it) }
            assertEquals(name, want, LiveCard.build(chats, previous, pinned, level, fixtureNow))
            ran++
        }
        assertTrue("ran $ran", ran >= 18)
        for (c in root["decode"] as JsonArray) {
            val o = c as JsonObject
            val s = LiveCardState.from(o["json"])
            assertEquals((o["name"] as JsonPrimitive).content, (o["states"] as JsonArray).map { (it as JsonPrimitive).content }, s.chats.map { it.state.wire })
        }
        for (c in root["shortTitle"] as JsonArray) {
            val (input, want) = (c as JsonArray).map { (it as JsonPrimitive).content }
            assertEquals(input, want, LiveCard.shortTitle(input))
        }
        for (c in root["closeWord"] as JsonArray) {
            val a = c as JsonArray
            assertEquals(a.toString(), (a[2] as JsonPrimitive).content, LiveCard.closeWord((a[0] as JsonPrimitive).content, (a[1] as JsonPrimitive).boolean))
        }
        for (c in root["replyLine"] as JsonArray) {
            val (input, want) = (c as JsonArray).map { (it as JsonPrimitive).content }
            assertEquals(input, want, LiveCard.replyLine(input))
        }
    }
}
