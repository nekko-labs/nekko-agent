package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors apps/desktop/src/renderer/replyTopics.test.ts. */
class ReplyTopicsTest {
    @Test fun `reads topic lines`() {
        listOf(
            "**Next step**: merge it" to TopicLine(Topic.NEXT, "Next step", "merge it"),
            "**Next step:** merge it" to TopicLine(Topic.NEXT, "Next step", "merge it"),
            "**Changes**" to TopicLine(Topic.SUMMARY, "Changes", ""),
            "**Not verified / blocked**: Windows" to TopicLine(Topic.SUMMARY, "Not verified / blocked", "Windows"),
            "**Run this**" to TopicLine(Topic.COMMAND, "Run this", ""),
            "**Decision**: kept the timeout" to TopicLine(Topic.DECISION, "Decision", "kept the timeout"),
            "## Open questions" to TopicLine(Topic.QUESTION, "Open questions", ""),
            "### **Next steps:**" to TopicLine(Topic.NEXT, "Next steps", ""),
        ).forEach { (line, expected) -> assertEquals(line, expected, ReplyTopics.topicLine(line)) }
    }

    @Test fun `leaves other lines alone`() {
        listOf(
            "**Changes** to the plan come later",
            "**Important**: not a topic we name",
            "Next step: plain words are not a label",
            "## Installation",
            "- **Next step**: a list item",
        ).forEach { assertNull(it, ReplyTopics.topicLine(it)) }
    }

    @Test fun `hears a message that stops on a question`() {
        assertTrue(ReplyTopics.speaksToUser("The signup test has the same timer.\n\nShould I fix it here too?"))
        assertTrue(ReplyTopics.speaksToUser("Does this look right?**"))
        assertTrue(ReplyTopics.speaksToUser("これでいいですか？"))
    }

    @Test fun `hears a label anywhere in the message`() {
        assertTrue(ReplyTopics.speaksToUser("Found it.\n\n**Decision**: kept the timeout.\n\nMoving on."))
    }

    @Test fun `leaves a progress note quiet`() {
        assertFalse(ReplyTopics.speaksToUser("I will read the test first."))
        assertFalse(ReplyTopics.speaksToUser("Why did it pass locally? The runner is slower, so I am checking that."))
    }

    @Test fun `ignores code`() {
        assertFalse(ReplyTopics.speaksToUser("Checking this.\n\n```md\n**Next step**: inside a fence\n```\n\nReading on."))
        assertFalse(ReplyTopics.speaksToUser("Running:\n```sh\ntest -f x?\n```"))
    }

    @Test fun `finds a closing question with no label`() {
        assertTrue(ReplyTopics.endsOnUnlabelledQuestion("All green.\n\nWant me to open the PR?"))
        assertTrue(ReplyTopics.endsOnUnlabelledQuestion("Pick one?\n\n```bash\nnpm test\n```"))
    }

    @Test fun `stays out when a label already announces the question`() {
        assertFalse(ReplyTopics.endsOnUnlabelledQuestion("**Question**\n\nWant me to open the PR?"))
        assertFalse(ReplyTopics.endsOnUnlabelledQuestion("**Next step**: want me to open the PR?"))
        assertFalse(ReplyTopics.endsOnUnlabelledQuestion("**Decision**: did that break it?"))
    }

    @Test fun `stays out when the message closes on a statement`() {
        assertFalse(ReplyTopics.endsOnUnlabelledQuestion("Did it pass? It did."))
    }

    @Test fun `cuts a message at its topic lines, not inside code`() {
        val s = ReplyTopics.sections("Fixed it.\n\n**Changes**\n- one\n\n```md\n**Next step**: no\n```\n**Next step**: merge it")
        assertEquals(listOf(null, "Changes", "Next step"), s.map { it.header?.label })
        assertEquals("Fixed it.", s[0].body)
        assertEquals("- one\n\n```md\n**Next step**: no\n```", s[1].body)
        assertEquals("merge it", s[2].body)
    }

    @Test fun `gives a closing question its header only when asked`() {
        val text = "All green.\n\nWant me to open the PR?\n\n```bash\ngh pr create\n```"
        assertEquals(1, ReplyTopics.sections(text).size)
        val s = ReplyTopics.sections(text, askTail = true)
        assertEquals(listOf(null, Topic.QUESTION), s.map { it.header?.topic })
        assertEquals("Want me to open the PR?\n\n```bash\ngh pr create\n```", s[1].body)
    }

    private fun say(id: String, text: String, streaming: Boolean = false) = Block.Assistant(id, text, streaming = streaming)
    private fun tool(id: String) = Block.Tool(id, "bash", "Run ls", ToolStatus.OK)

    @Test fun `voices follow each text's place in its turn`() {
        val blocks = listOf(
            Block.User("u1", "hi"), say("a1", "Hello."),
            Block.User("u2", "fix it"), say("a2", "Reading the test."), tool("t1"),
            say("a3", "Should I fix signup too?"), tool("t2"), say("a4", "Fixed."),
        )
        assertEquals(
            listOf(null, null, null, Voice.WORKING, null, Voice.ATTENTION, null, Voice.REPLY),
            ReplyTopics.voices(blocks),
        )
    }

    @Test fun `the newest text has no voice while its turn runs`() {
        val blocks = listOf(Block.User("u", "go"), tool("t"), say("a", "Fixed."))
        assertNull(ReplyTopics.voices(blocks, running = true)[2])
        assertNull(ReplyTopics.voices(listOf(Block.User("u", "go"), tool("t"), say("a", "Fix", streaming = true)))[2])
        assertEquals(Voice.REPLY, ReplyTopics.voices(blocks)[2])
    }
}
