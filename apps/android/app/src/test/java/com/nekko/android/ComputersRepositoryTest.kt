package com.nekko.android

import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.DEFAULT_COMPUTER_NAME
import com.nekko.android.data.osName
import com.nekko.protocol.Activity
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Channels
import com.nekko.protocol.E2E
import com.nekko.protocol.Events
import com.nekko.protocol.PairingLink
import com.nekko.protocol.RelayState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The repository collects relay flows in `backgroundScope`; `advanceUntilIdle()`
 * ignores background work, so these tests step with `runCurrent()`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ComputersRepositoryTest {
    private val room = "a1b2c3d4e5f60718"
    private val key = "00112233445566778899aabbccddeeff"
    private val link = PairingLink("wss://relay.example.dev", room, key, pair = "ABC123")
    private val derived = ByteArray(32) { it.toByte() }

    private fun TestScope.repo(store: FakeStore = FakeStore(), remotes: FakeRemotes = FakeRemotes()): ComputersRepository {
        var n = 0
        return ComputersRepository(
            store = store,
            remotes = remotes,
            scope = backgroundScope,
            deviceName = { "Pixel Test" },
            deriveKey = { _, _ -> derived },
            newId = { "id-${++n}" },
            now = { 1_000L },
        )
    }

    private fun secretOf(store: FakeStore, id: String) =
        Json.parseToJsonElement(store.map.getValue(ComputersRepository.secretKey(id))).jsonObject

    @Test
    fun `pairing stores the secret, connects, and drops the pair code once welcomed`() = runTest {
        val store = FakeStore()
        val remotes = FakeRemotes()
        val repo = repo(store, remotes)

        val id = repo.pair(link)
        runCurrent()

        val secret = secretOf(store, id)
        assertEquals(room, secret["room"]!!.jsonPrimitive.content)
        assertEquals(key, secret["key"]!!.jsonPrimitive.content)
        assertEquals(E2E.toHex(derived), secret["keyHex"]!!.jsonPrimitive.content)
        assertEquals("ABC123", secret["pair"]!!.jsonPrimitive.content)

        val index = Json.parseToJsonElement(store.map.getValue(ComputersRepository.INDEX_KEY)).jsonArray
        assertEquals(1, index.size)
        // The index is not secret and must never carry key material.
        assertFalse(store.map.getValue(ComputersRepository.INDEX_KEY).contains(key))
        assertEquals(id, store.map[ComputersRepository.ACTIVE_KEY])
        assertNotNull(store.map[ComputersRepository.DEVICE_KEY])

        val remote = remotes.last
        assertTrue(remote.connected)
        assertEquals("ABC123", remote.config.pairCode)
        assertEquals("android", remote.config.platform)
        assertEquals("Pixel Test", remote.config.deviceName)
        assertEquals(id, repo.state.value.activeId)
        assertEquals(DEFAULT_COMPUTER_NAME, repo.state.value.active?.name)

        remote.sayWelcome()
        runCurrent()

        assertNull(secretOf(store, id)["pair"])
        assertEquals(key, secretOf(store, id)["key"]!!.jsonPrimitive.content)
        assertEquals(RelayState.ONLINE, repo.state.value.conn)
    }

    @Test
    fun `re-pairing the same computer keeps its id and name`() = runTest {
        val store = FakeStore()
        val repo = repo(store)
        val id = repo.pair(link)
        repo.rename(id, "Studio")
        val again = repo.pair(link.copy(pair = "NEW999"))
        assertEquals(id, again)
        assertEquals(1, repo.state.value.computers.size)
        assertEquals("Studio", repo.state.value.computers.single().name)
        assertEquals("NEW999", secretOf(store, id)["pair"]!!.jsonPrimitive.content)
    }

    @Test
    fun `forget removes the secret and switches to the next computer`() = runTest {
        val store = FakeStore()
        val remotes = FakeRemotes()
        val repo = repo(store, remotes)
        val first = repo.pair(link)
        val second = repo.pair(link.copy(room = "ffeeddccbbaa9988"))
        runCurrent()
        assertEquals(second, repo.state.value.activeId)
        val secondRemote = remotes.last

        repo.forget(second)
        runCurrent()

        assertTrue(secondRemote.closed)
        assertNull(store.map[ComputersRepository.secretKey(second)])
        assertNotNull(store.map[ComputersRepository.secretKey(first)])
        assertEquals(listOf(first), repo.state.value.computers.map { it.id })
        assertEquals(first, repo.state.value.activeId)
        assertEquals(first, store.map[ComputersRepository.ACTIVE_KEY])
        assertEquals(room, remotes.last.config.room)

        repo.forget(first)
        runCurrent()
        assertTrue(repo.state.value.computers.isEmpty())
        assertNull(repo.state.value.activeId)
        assertNull(store.map[ComputersRepository.ACTIVE_KEY])
        assertEquals(RelayState.IDLE, repo.state.value.conn)
    }

    @Test
    fun `refresh on ONLINE names the computer after its OS and keeps public fields only`() = runTest {
        val store = FakeStore()
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.APP_INFO -> buildJsonObject { put("platform", "darwin"); put("version", "1.2.3") }
                Channels.PROVIDERS_LIST -> buildJsonArray {
                    add(buildJsonObject {
                        put("id", "openai"); put("kind", "openai"); put("label", "OpenAI"); put("enabled", true)
                        put("apiKey", "sk-secret")
                    })
                }
                Channels.SETTINGS_GET -> buildJsonObject {
                    put("defaultProviderId", "openai"); put("defaultModelId", "gpt"); put("relayKey", "secret")
                }
                Channels.SESSIONS_SUMMARIES -> buildJsonArray {
                    add(buildJsonObject { put("id", "s1"); put("title", "Hello"); put("updatedAt", 5) })
                    add(buildJsonObject { put("id", "s2"); put("title", "Sub"); put("updatedAt", 6); put("parentSessionId", "s1") })
                }
                Channels.CHAT_PENDING -> buildJsonObject {
                    put("s1", buildJsonObject {
                        put("approval", buildJsonObject {
                            put("call", buildJsonObject { put("id", "c1"); put("name", "bash"); put("input", buildJsonObject { put("command", "ls") }) })
                            put("reason", "runs a command"); put("severity", "medium")
                        })
                    })
                }
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(store, remotes)
        val id = repo.pair(link)
        remotes.last.goOnline()
        runCurrent()

        val s = repo.state.value
        assertEquals("Mac", s.active?.name)
        assertEquals("darwin", s.active?.platform)
        assertTrue(store.map.getValue(ComputersRepository.INDEX_KEY).contains("\"Mac\""))
        assertEquals(listOf("s1"), s.summaries.map { it.id })
        assertEquals("OpenAI", s.providers.single().label)
        assertEquals("gpt", s.defaults.defaultModelId)
        assertEquals(Activity.NEEDS_YOU, s.activity["s1"])
        assertFalse(s.summariesLoading)
        assertEquals(id, s.activeId)
    }

    @Test
    fun `a renamed computer keeps its name when the OS is learned`() = runTest {
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.APP_INFO) buildJsonObject { put("platform", "win32") } else FakeRemotes.defaultAnswer(c)
        }
        val repo = repo(remotes = remotes)
        val id = repo.pair(link)
        repo.rename(id, "Gaming rig")
        remotes.last.goOnline()
        runCurrent()
        assertEquals("Gaming rig", repo.state.value.active?.name)
        assertEquals("win32", repo.state.value.active?.platform)
    }

    @Test
    fun `osName maps host platforms`() {
        assertEquals("Windows PC", osName("win32"))
        assertEquals("Mac", osName("darwin"))
        assertEquals("Linux PC", osName("linux"))
        assertEquals("My computer", osName("freebsd"))
        assertEquals("My computer", osName(null))
    }

    @Test
    fun `agent events update activity, reach listeners, and debounce a summaries refresh`() = runTest {
        val remotes = FakeRemotes()
        val repo = repo(remotes = remotes)
        repo.pair(link)
        val remote = remotes.last
        remote.goOnline()
        runCurrent()
        val seen = mutableListOf<AgentEvent>()
        val job = backgroundScope.launch { repo.events.toList(seen) }
        runCurrent()
        val before = remote.channels().count { it == Channels.SESSIONS_SUMMARIES }

        remote.events.emit(Events.AGENT_EVENT to buildJsonObject { put("sessionId", "s1"); put("type", "text"); put("delta", "hi") })
        runCurrent()
        assertEquals(Activity.RUNNING, repo.state.value.activity["s1"])

        remote.events.emit(Events.AGENT_EVENT to buildJsonObject { put("sessionId", "s1"); put("type", "done") })
        remote.events.emit(Events.AGENT_EVENT to buildJsonObject { put("sessionId", "s2"); put("type", "session_meta") })
        runCurrent()
        assertNull(repo.state.value.activity["s1"])
        advanceTimeBy(599)
        runCurrent()
        assertEquals(before, remote.channels().count { it == Channels.SESSIONS_SUMMARIES })
        advanceTimeBy(2)
        runCurrent()
        assertEquals(before + 1, remote.channels().count { it == Channels.SESSIONS_SUMMARIES })
        assertEquals(3, seen.size)
        job.cancel()
    }

    @Test
    fun `load restores the active computer and nudge reaches the client`() = runTest {
        val store = FakeStore()
        val remotes = FakeRemotes()
        repo(store, remotes).pair(link)
        val second = repo(store, remotes)
        second.load()
        runCurrent()
        assertTrue(second.state.value.ready)
        assertEquals("id-1", second.state.value.activeId)
        assertEquals(2, remotes.created.size)
        second.nudge()
        assertEquals(1, remotes.last.nudges)
        // The pair code is still pending: the second connection must offer it too.
        assertEquals("ABC123", remotes.last.config.pairCode)
    }

    @Test
    fun `loadModels caches per provider`() = runTest {
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.MODELS_LIST) {
                buildJsonArray { add(buildJsonObject { put("id", "m1"); put("providerId", "p"); put("name", "Model 1"); put("loaded", true) }) }
            } else FakeRemotes.defaultAnswer(c)
        }
        val repo = repo(remotes = remotes)
        repo.pair(link)
        val a = repo.loadModels("p")
        val b = repo.loadModels("p")
        assertEquals(a, b)
        assertTrue(a.single().loaded)
        assertEquals(1, remotes.last.channels().count { it == Channels.MODELS_LIST })
        assertEquals(JsonPrimitive("p"), remotes.last.calls.first { it.channel == Channels.MODELS_LIST }.args.single())
    }
}
