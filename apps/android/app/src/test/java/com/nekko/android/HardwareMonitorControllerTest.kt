package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.data.PhonePrefs
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.monitors.HardwareMonitorController
import com.nekko.protocol.Block
import com.nekko.protocol.Channels
import com.nekko.protocol.ContextUsage
import com.nekko.protocol.ENGINE_PROVIDER_ID
import com.nekko.protocol.Effort
import com.nekko.protocol.LiveTurn
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The Expert monitor, the chat's context and effort, and the Simple / Expert pref (the iPhone's HardwareMonitorModelTests). */
@OptIn(ExperimentalCoroutinesApi::class)
class HardwareMonitorControllerTest {
    private fun json(s: String): JsonElement = com.nekko.protocol.WireJson.parseToJsonElement(s)

    private val replies = mapOf(
        Channels.SYSTEM_STATS to json("""{"cpuPct":12,"memUsedMB":1024,"memTotalMB":4096}"""),
        Channels.GPU_STATS to json("""{"totalMB":8192,"usedMB":2048,"devices":[{"utilizationPct":40}]}"""),
        Channels.ENGINE_STATUS to json("""{"installed":true,"running":true,"resident":[{"id":"gemma","contextLength":32768,"vramBytes":3000000000}]}"""),
    )

    @Test fun `reads hardware and loaded models, with no arguments`() = runTest {
        val caller = FakeCaller { replies[it.channel] ?: JsonNull }
        val m = HardwareMonitorController(caller) { "Mac" }
        m.refresh()
        val s = m.state.value
        assertTrue(s.loaded)
        assertNull(s.error)
        assertEquals(12.0, s.system!!.cpuPct, 0.0)
        assertEquals(40.0, s.gpu!!.devices.single().utilizationPct!!, 0.0)
        assertEquals(listOf("gemma"), s.engine!!.resident.map { it.id })
        assertEquals(setOf(Channels.SYSTEM_STATS, Channels.GPU_STATS, Channels.ENGINE_STATUS), caller.channels().toSet())
        assertTrue(caller.calls.all { it.args.isEmpty() })
    }

    @Test fun `an older computer says it has no monitors, and one missing reading leaves the rest`() = runTest {
        val refuse: suspend (Call) -> JsonElement = { throw RelayException("Not allowed from a paired phone (channel-denied): ${it.channel}") }
        val m = HardwareMonitorController(FakeCaller(refuse)) { "Mac" }
        m.refresh()
        assertNull(m.state.value.system)
        assertEquals("Mac didn’t send its monitors. Update Nekko Agent there to see them.", m.state.value.error)

        val partly = HardwareMonitorController(FakeCaller { if (it.channel == Channels.GPU_STATS) refuse(it) else replies.getValue(it.channel) }) { "Mac" }
        partly.refresh()
        assertNull(partly.state.value.gpu)
        assertTrue(partly.state.value.system != null && partly.state.value.error == null)

        val readOff = HardwareMonitorController(FakeCaller { throw RelayException("Not allowed from a paired phone (read-off): ${it.channel}") }) { "Mac" }
        readOff.refresh()
        assertTrue(readOff.state.value.error!!.startsWith("Reading from this phone is turned off on Mac"))
    }

    @Test fun `polls every three seconds until cancelled`() = runTest {
        val caller = FakeCaller { replies[it.channel] ?: JsonNull }
        val m = HardwareMonitorController(caller) { "Mac" }
        val job = launch { m.poll() }
        runCurrent()
        assertEquals(3, caller.calls.size)
        advanceTimeBy(HardwareMonitorController.POLL_MS - 1)
        runCurrent()
        assertEquals(3, caller.calls.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(6, caller.calls.size)
        job.cancel()
        advanceTimeBy(HardwareMonitorController.POLL_MS * 3)
        runCurrent()
        assertEquals(6, caller.calls.size)
    }

    @Test fun `unloading names the Model Server, re-reads and says a refusal`() = runTest {
        var unload = json("""{"ok":true,"message":"Unloaded gemma."}""")
        val caller = FakeCaller {
            if (it.channel == Channels.MODEL_UNLOAD) {
                assertEquals(listOf(JsonPrimitive(ENGINE_PROVIDER_ID), JsonPrimitive("gemma")), it.args)
                unload
            } else replies.getValue(it.channel)
        }
        val m = HardwareMonitorController(caller) { "Mac" }
        assertEquals("Unloaded gemma.", m.unload("gemma"))
        assertNull(m.state.value.unloading)
        assertEquals("re-read after unloading", 1, caller.channels().count { it == Channels.ENGINE_STATUS })

        unload = json("""{"ok":false,"message":"Model Server is stopped."}""")
        try {
            m.unload("gemma")
            fail("a refused unload throws")
        } catch (e: RelayException) {
            assertEquals("Model Server is stopped.", e.message)
        }
        assertNull(m.state.value.unloading)
    }

    @Test fun `the chat reads its context, counts the streaming reply and sets its effort`() = runTest {
        val session = buildJsonObject { put("id", "s1"); put("title", "t"); put("providerId", "anthropic"); put("modelId", "claude-opus-4-7"); put("effort", "high") }
        val caller = FakeCaller {
            when (it.channel) {
                Channels.SESSION_GET -> session
                Channels.CONTEXT_PREVIEW -> {
                    assertEquals(listOf(JsonPrimitive("s1")), it.args)
                    json("""{"usedTokens":4000,"contextWindow":32000,"sources":{"conversation":3000,"system":1000}}""")
                }
                else -> JsonNull
            }
        }
        val env = ChatEnv(RelayState.ONLINE, null, RemoteDefaults(), "Mac", mapOf("anthropic" to listOf(ModelInfo("claude-opus-4-7", "anthropic", "Claude Opus 4.7", false))))
        val c = ChatController("s1", caller, backgroundScope, { env })
        c.reload()
        runCurrent()
        val ui = ChatController.project(c.state.value, env)
        assertEquals(4000L, ui.context!!.usedTokens)
        assertEquals(4000L, ui.contextTokens)
        assertEquals(Effort.HIGH, ui.effort)
        assertEquals("Claude Opus 4.7", ui.modelName)

        // While a reply streams, about one token per four characters.
        val live = LiveTurn(running = true, blocks = listOf(Block.Assistant("a", "x".repeat(400))))
        assertEquals(4100L, ChatController.liveTokens(ContextUsage(4000, 32000), live))
        assertEquals(4000L, ChatController.liveTokens(ContextUsage(4000, 32000), live.copy(running = false)))
        assertNull(ChatController.liveTokens(null, live))

        c.setOptions(effort = Effort.MAX)
        val set = caller.calls.last { it.channel == Channels.SESSION_SET_OPTIONS }
        assertEquals(listOf(JsonPrimitive("s1"), buildJsonObject { put("effort", "max") }), set.args)
        assertEquals("re-read after setting", Channels.SESSION_GET, caller.calls.last { it.channel != Channels.CONTEXT_PREVIEW && it.channel != Channels.CHAT_PENDING && it.channel != Channels.SKILLS_RUNNABLE }.channel)
        c.setOptions(providerId = "openai", modelId = "gpt-5.1")
        assertEquals(buildJsonObject { put("providerId", "openai"); put("modelId", "gpt-5.1") }, caller.calls.last { it.channel == Channels.SESSION_SET_OPTIONS }.args[1])
    }

    @Test fun `expert mode is off until chosen, and remembered`() {
        val store = object : com.nekko.android.data.PrefStore {
            val map = HashMap<String, String>()
            override fun getString(name: String) = map[name]
            override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
        }
        assertFalse(PhonePrefs(store).get(EXPERT_MODE))
        PhonePrefs(store).set(EXPERT_MODE, true)
        assertTrue(PhonePrefs(store).get(EXPERT_MODE))
    }
}
