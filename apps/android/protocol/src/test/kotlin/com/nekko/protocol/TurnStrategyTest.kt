package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnStrategyTest {
    private fun message(id: String, strategy: String = "null", role: String = "user") = ChatMessage.from(Json.parseToJsonElement(
        """{"id":"$id","role":"$role","turnStrategy":$strategy}""",
    ))!!

    @Test fun `wire accepts only known modes on user messages and saves only typed keys`() {
        val strategy = """{"tools":"code","orchestration":"coordinator","reason":"requested","modelId":"parent","subagentModelId":"worker","extra":"ignore"}"""
        val user = message("u", strategy)
        assertEquals(TurnStrategy(TurnStrategy.Tools.CODE, TurnStrategy.Orchestration.COORDINATOR, TurnStrategy.Reason.REQUESTED, "parent", "worker"), user.turnStrategy)
        assertEquals(user, ChatMessage.from(user.savedJson()))
        assertEquals(Json.parseToJsonElement("""{"tools":"code","orchestration":"coordinator","reason":"requested","modelId":"parent","subagentModelId":"worker"}"""), user.savedJson()["turnStrategy"])
        assertNull(message("a", strategy, role = "assistant").turnStrategy)
        assertNull(message("u", """{"tools":false,"orchestration":"direct"}""").turnStrategy)
        assertNull(message("u", """{"tools":"code","orchestration":"future"}""").turnStrategy)
    }

    @Test fun `sections include all known strategies even when modes repeat`() {
        val messages = listOf(
            message("old"),
            message("u1", """{"tools":"code","orchestration":"direct","reason":"not-needed"}"""),
            message("future", """{"tools":"future","orchestration":"direct"}"""),
            message("u2", """{"tools":"code","orchestration":"direct","reason":"off"}"""),
            message("u3", """{"tools":"code","orchestration":"coordinator","reason":"unknown"}"""),
            message("u4", """{"tools":"list","orchestration":"coordinator"}"""),
            message("u5", """{"tools":"claude-code","orchestration":"external"}"""),
        )
        val sections = TurnStrategy.sections(messages)
        assertEquals(setOf("u1", "u2", "u3", "u4", "u5"), sections.keys)
        assertNull(sections.getValue("u3").reason)
        assertEquals(TurnStrategy.Orchestration.EXTERNAL, sections.getValue("u5").orchestration)
        assertTrue(TurnStrategy.sections(messages.take(1)).isEmpty())
    }
}
