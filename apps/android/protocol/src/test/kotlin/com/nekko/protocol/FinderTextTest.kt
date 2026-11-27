package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FinderTextTest {
    private fun chat(id: String, title: String, first: String? = null, last: String? = null, updatedAt: Long = 1) = SessionSummary(
        id = id, title = title, updatedAt = updatedAt, modelId = null, lastReplyText = last, firstUserText = first,
        archived = false, parentSessionId = null, taskId = null, trainingRunId = null,
    )

    private fun texts(vararg chats: Pair<String, List<FinderMessage>>) = chats.associate { (id, m) -> id to FinderChat(m) }

    @Test fun parsesAReplyLeavingOutWhatTheComputerDidNotSend() {
        val reply = WireJson.parseToJsonElement(
            """{"s1":{"title":"t","updatedAt":5,"messages":[{"role":"user","text":"hello"},{"role":"assistant","text":"done","files":["NOTES.md"]},{"text":"no role"}]},"gone":null}""",
        )
        val parsed = FinderChat.parse(reply)
        assertEquals(setOf("s1", "gone"), parsed.keys)
        assertEquals(listOf(FinderMessage("user", "hello"), FinderMessage("assistant", "done", listOf("NOTES.md"))), parsed["s1"]!!.messages)
        assertEquals("a chat the computer doesn't have is known to be empty", emptyList<FinderMessage>(), parsed["gone"]!!.messages)
        assertEquals(emptyMap<String, FinderChat>(), FinderChat.parse(null))
    }

    @Test fun findsAPhraseSaidMidChatWithItsLine() {
        val chats = listOf(chat("a", "Release notes", "Group the notes", "Done"), chat("b", "Other", "x", "y"))
        val said = "We agreed earlier that the cache key should drop the runner image date and keep only the lockfile hash."
        val hits = FinderSearch.hits(chats, "runner image", texts("a" to listOf(FinderMessage("user", "hi"), FinderMessage("assistant", said))))
        assertEquals(listOf("a"), hits.map { it.chat.id })
        assertEquals("the same cut as the desktop finder's snippetAround", "…che key should drop the runner image date and keep only the lockfile hash.", hits[0].snippet)
    }

    @Test fun keepsTheSummarySearchWithoutTexts() {
        val chats = listOf(chat("a", "Café résumé"), chat("b", "Bug hunt", "find the BUG"))
        assertEquals(listOf("a"), FinderSearch.hits(chats, "cafe resume", emptyMap()).map { it.chat.id })
        assertNull("a title match needs no snippet", FinderSearch.hits(chats, "cafe", emptyMap())[0].snippet)
        val desc = FinderSearch.hits(chats, "bug find", emptyMap())
        assertEquals(listOf("b"), desc.map { it.chat.id })
        assertEquals("find the BUG", desc[0].snippet)
        assertEquals(chats.size, FinderSearch.hits(chats, "  ", emptyMap()).size)
        assertEquals("without texts, words only in messages find nothing", emptyList<ChatHit>(), FinderSearch.hits(chats, "lockfile", emptyMap()))
    }

    @Test fun needsEveryWordSomewhereInTheChat() {
        val chats = listOf(chat("a", "Deploy"))
        val t = texts("a" to listOf(FinderMessage("user", "roll back the release"), FinderMessage("assistant", "rolled back", listOf("deploy/prod.yaml"))))
        assertEquals("one word in the title, one in a message", listOf("a"), FinderSearch.hits(chats, "deploy release", t).map { it.chat.id })
        assertEquals(emptyList<ChatHit>(), FinderSearch.hits(chats, "deploy staging", t))
        val file = FinderSearch.hits(chats, "prod.yaml", t)
        assertEquals("a file a tool call named is searched, and shown when the text lacks the word", "deploy/prod.yaml", file[0].snippet)
    }

    @Test fun cutsTheSnippetLikeTheDesktop() {
        assertEquals("short line", FinderSearch.snippetAround("short line", "line"))
        assertNull(FinderSearch.snippetAround("nothing here", "missing"))
        val long = "a".repeat(100) + " Éclair " + "b".repeat(100)
        val s = FinderSearch.snippetAround(long, "eclair")!!
        assertEquals("…" + "a".repeat(23) + " Éclair " + "b".repeat(59) + "…", s)
        // Never half of a surrogate pair at either end.
        val emoji = "😀".repeat(20) + " target " + "😀".repeat(60)
        val e = FinderSearch.snippetAround(emoji, "target")!!
        assertEquals(e, String(e.codePoints().toArray(), 0, e.codePointCount(0, e.length)))
    }
}
