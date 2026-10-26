package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The shared purpose fixture (packages/shared/fixtures/tool-purpose.json), the
 * same cases the TS classifier (Vitest) and the Swift port run.
 */
class ToolPurposeTest {
    private val fixture: JsonObject by lazy {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "packages/shared/fixtures/tool-purpose.json")
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun JsonObject.s(key: String) = (this[key] as? JsonPrimitive)?.content ?: ""
    private fun JsonObject.input() = this["input"] as? JsonObject ?: JsonObject(emptyMap())

    @Test fun `every purpose case matches`() {
        val cases = fixture["purposes"]!!.jsonArray
        assertTrue(cases.size >= 60)
        for (c in cases.map { it.jsonObject }) {
            assertEquals("${c.s("name")} ${c.input()}", c.s("purpose"), Purpose.of(c.s("name"), c.input()).id)
        }
    }

    @Test fun `every goal case matches`() {
        for (c in fixture["goals"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c.s("name"), c.s("goal"), Purpose.goal(c.s("name"), c.input()))
        }
    }

    @Test fun `every headline case matches`() {
        for (c in fixture["headlines"]!!.jsonArray.map { it.jsonObject }) {
            val calls = (c["calls"] as JsonArray).map { it.jsonObject }.map {
                PurposeCall(it.s("name"), it.input(), (it["failed"] as? JsonPrimitive)?.booleanOrNull ?: false)
            }
            val h = Purpose.headline(ToolPurpose.of(c.s("purpose"))!!, calls, c["running"]!!.jsonPrimitive.boolean)
            assertEquals(c.s("headline"), h.headline)
            assertEquals(c.s("headline"), c.s("detail"), h.detail)
        }
    }

    private fun tool(id: String, name: String, input: Map<String, String>, status: ToolStatus = ToolStatus.OK) =
        Block.Tool(id, name, name, status, input = JsonObject(input.mapValues { JsonPrimitive(it.value) }))

    private fun shape(blocks: List<Block>) = Purpose.group(blocks, Purpose::role).map {
        when (it) {
            is PurposeRun.Single -> it.item.id
            is PurposeRun.Group -> "${it.purpose.id}:" + it.items.joinToString(",") { b -> b.id }
        }
    }

    @Test fun `groups adjacent same-purpose blocks`() {
        val blocks = listOf(
            Block.User("u", "go"),
            tool("a", "read_file", mapOf("path" to "AGENTS.md")),
            Block.Assistant("t", "", reasoning = "next"),
            tool("b", "read_file", mapOf("path" to "CLAUDE.md")),
            tool("c", "read_file", mapOf("path" to "src/a.ts")),
            tool("d", "grep", mapOf("pattern" to "x")),
            Block.Assistant("r", "Found it."),
            tool("e", "bash", mapOf("command" to "npm test")),
            tool("f", "bash", mapOf("command" to "npm run lint"), ToolStatus.ERROR),
        )
        assertEquals(listOf("u", "guidance:a,t,b", "explore:c,d", "r", "check:e,f"), shape(blocks))
    }

    @Test fun `approval, questions and lone calls stay single`() {
        val blocks = listOf(
            tool("a", "bash", mapOf("command" to "npm install")),
            tool("b", "bash", mapOf("command" to "node x.mjs")),
            tool("c", "bash", mapOf("command" to "rm -rf build"), ToolStatus.WAITING),
            tool("q", "ask_user", emptyMap()),
            tool("d", "edit_file", mapOf("path" to "a.ts")),
        )
        assertEquals(listOf("run:a,b", "c", "q", "d"), shape(blocks))
    }
}
