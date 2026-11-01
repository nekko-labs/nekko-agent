package com.nekko.android

import com.nekko.android.data.ChatListCache
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
import com.nekko.protocol.SavedChatList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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

    private val forgotten = mutableListOf<String>()

    private fun TestScope.repo(
        store: FakeStore = FakeStore(),
        remotes: FakeRemotes = FakeRemotes(),
        signer: com.nekko.protocol.ChangeSigner? = null,
        offline: com.nekko.protocol.OfflineFiles? = null,
        probe: com.nekko.protocol.ProbeNetwork = object : com.nekko.protocol.ProbeNetwork {
            override suspend fun resolve(host: String, timeoutMs: Long) = listOf("100.101.102.103")
            override suspend fun connect(address: String, port: Int, timeoutMs: Long) {}
        },
    ): ComputersRepository {
        var n = 0
        return ComputersRepository(
            probeNetwork = probe,
            offlineFiles = offline,
            draftDebounceMs = 0,
            changeSigner = signer,
            onForget = { forgotten += it },
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

    private class MemoryLists : ChatListCache {
        val lists = mutableMapOf<String, SavedChatList>()
        override fun load(computerId: String) = lists[computerId]
        override fun save(computerId: String, list: SavedChatList) { lists[computerId] = list }
        override fun remove(computerId: String) { lists.remove(computerId) }
    }

    private val listAnswers = FakeRemotes { c ->
        when (c.channel) {
            Channels.SESSIONS_SUMMARIES -> Json.parseToJsonElement(
                """[{"id":"s1","title":"Fix it","updatedAt":5,"lastReplyText":"secret reply"},{"id":"sub","title":"x","updatedAt":9,"parentSessionId":"s1"}]""",
            )
            Channels.WORKSPACE_LIST -> Json.parseToJsonElement("""[{"id":"w","name":"App"}]""")
            else -> FakeRemotes.defaultAnswer(c)
        }
    }

    @Test
    fun `the saved list shows until the computer answers and never keeps content`() = runTest {
        val store = FakeStore()
        val lists = MemoryLists()
        val repo = repo(store, listAnswers)
        repo.chatListCache = lists
        val id = repo.pair(link)
        runCurrent()
        assertNull("nothing saved before the computer answers", lists.lists[id])
        listAnswers.last.goOnline()
        runCurrent()
        val saved = lists.lists.getValue(id)
        assertEquals(listOf("s1"), saved.summaries.map { it.id })
        assertEquals(listOf("App"), saved.folders.map { it.name })
        assertFalse(saved.json().toString().contains("secret"))
        assertNull(repo.state.value.savedListAt)

        // Next launch, the computer unreachable: the saved list, marked as saved.
        val again = repo(store, FakeRemotes())
        again.chatListCache = lists
        again.load()
        runCurrent()
        assertEquals(listOf("Fix it"), again.state.value.summaries.map { it.title })
        assertEquals(listOf("w"), again.state.value.workspaces.map { it.id })
        assertEquals(1_000L, again.state.value.savedListAt)

        again.forget(id)
        runCurrent()
        assertNull("forgetting a computer drops its list", lists.lists[id])
    }

    @Test
    fun `nothing is kept until the setting is turned on`() = runTest {
        val repo = repo(remotes = listAnswers)
        val id = repo.pair(link)
        runCurrent()
        listAnswers.last.goOnline()
        runCurrent()
        val lists = MemoryLists()
        assertTrue(lists.lists.isEmpty())
        repo.chatListCache = lists
        assertEquals("turned on while online: the list as it is now", listOf("s1"), lists.lists[id]?.summaries?.map { it.id })
        repo.chatListCache = null
        assertNull(repo.state.value.savedListAt)
    }

    @Test
    fun `the saved list's note says when and that it is not live`() {
        val zone = java.time.ZoneOffset.UTC
        val now = 1_800_000_000_000L
        val today = com.nekko.android.ui.screens.savedListNote(now - 600_000, "Mac", now, zone)
        assertTrue(today, today.startsWith("Saved list from ") && today.endsWith("It updates when Mac answers."))
        val older = com.nekko.android.ui.screens.savedListNote(now - 3 * 86_400_000L, "Mac", now, zone)
        assertTrue("an older list also names the day", older.length > today.length)
    }

    @Test
    fun `the connection log follows the active computer and holds no secrets`() = runTest {
        val remotes = FakeRemotes()
        val repo = repo(remotes = remotes)
        val a = repo.pair(link)
        runCurrent()
        remotes.last.status.value = com.nekko.protocol.RelayStatus(RelayState.CONNECTING, "handshake timed out")
        runCurrent()
        remotes.last.goOnline()
        runCurrent()
        val states = repo.connectionLog.value.map { it.state }
        assertEquals(RelayState.CONNECTING, states.first())
        assertEquals(RelayState.ONLINE, states.last())
        assertTrue(repo.connectionLog.value.any { it.detail == "handshake timed out" })
        val text = repo.connectionLogText()
        assertTrue(text, text.startsWith("Relay: relay.example.dev (internet)"))
        assertFalse(text.contains(room) || text.contains(key) || text.contains("ABC123"))

        repo.connect(a)
        runCurrent()
        assertTrue("reconnecting the same computer keeps its history", repo.connectionLog.value.size > states.size)
        repo.pair(PairingLink("wss://other.example.dev", "ffffffffffffffff", key))
        runCurrent()
        assertEquals("another computer starts its own", listOf(RelayState.CONNECTING), repo.connectionLog.value.map { it.state }.distinct())
    }

    @Test
    fun `a pairing saved before derived relay credentials asks to pair again without dialing`() = runTest {
        val store = FakeStore()
        val id = repo(store).pair(link)
        runCurrent()
        assertEquals(2, secretOf(store, id)["v"]!!.jsonPrimitive.content.toInt())
        // As an older app saved it: no version.
        val old = secretOf(store, id).filterKeys { it != "v" }
        store.map[ComputersRepository.secretKey(id)] = kotlinx.serialization.json.JsonObject(old).toString()

        val remotes = FakeRemotes()
        val again = repo(store, remotes)
        again.load()
        runCurrent()
        assertTrue("no connection on the old pairing", remotes.created.isEmpty())
        assertEquals(RelayState.DENIED, again.state.value.conn)
        assertEquals(com.nekko.protocol.DenyReason.BAD_KEY, again.state.value.denied)

        // Scanning the computer's new QR pairs again and connects.
        again.pair(link.copy(room = "0123456789abcdef"))
        runCurrent()
        assertEquals(1, remotes.created.size)
        assertEquals(RelayState.CONNECTING, again.state.value.conn)
    }

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
    fun `the computer's protocol from its welcome names the side to update, and is forgotten on switching`() = runTest {
        val remotes = FakeRemotes()
        val repo = repo(remotes = remotes)
        repo.pair(link)
        assertEquals(com.nekko.protocol.ProtocolCheck.SAME, repo.state.value.protocolCheck)
        remotes.last.sayWelcome(protocol = com.nekko.protocol.PhoneProtocol.VERSION - 1)
        runCurrent()
        assertEquals(com.nekko.protocol.PhoneProtocol.VERSION - 1, repo.state.value.hostProtocol)
        assertEquals(com.nekko.protocol.ProtocolCheck.UPDATE_COMPUTER, repo.state.value.protocolCheck)

        repo.pair(PairingLink("wss://other.example.dev", "ffffffffffffffff", key))
        assertNull("another computer hasn't said yet", repo.state.value.hostProtocol)
        remotes.last.sayWelcome()
        runCurrent()
        assertEquals(com.nekko.protocol.ProtocolCheck.SAME, repo.state.value.protocolCheck)
    }

    @Test
    fun `the link's routes are kept, given to the connection, and the one in use is shown`() = runTest {
        val store = FakeStore()
        val remotes = FakeRemotes()
        val repo = repo(store, remotes)
        repo.setNetworkPath(com.nekko.protocol.NetworkPath.LOCAL)
        val lan = "ws://192.168.1.20:4400"
        val id = repo.pair(link.copy(alts = listOf(lan)))
        runCurrent()
        assertEquals(listOf(lan), remotes.last.config.alts)
        assertEquals(listOf("wss://relay.example.dev", lan), remotes.last.config.routes)
        assertEquals("the connection starts from the phone's network", listOf("same" to com.nekko.protocol.NetworkPath.LOCAL), remotes.last.paths)
        remotes.last.status.value = com.nekko.protocol.RelayStatus(RelayState.ONLINE, route = lan)
        runCurrent()
        assertEquals(lan, repo.state.value.route)
        repo.networkChanged(com.nekko.protocol.NetworkPath.CELLULAR)
        assertEquals("changed" to com.nekko.protocol.NetworkPath.CELLULAR, remotes.last.paths.last())
        // Saved with the computer; a later link with other routes replaces them.
        assertEquals(listOf(lan), repo(store).also { it.load() }.state.value.computers.single { it.id == id }.alts)
        repo.pair(link.copy(alts = emptyList()))
        assertEquals(emptyList<String>(), repo.state.value.computers.single().alts)
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
    fun `pending summary invalidations read stale one then final zero without extra requests`() = runTest {
        val remotes = FakeRemotes()
        val repo = repo(remotes = remotes)
        repo.pair(link)
        val remote = remotes.last
        remote.goOnline()
        runCurrent()
        val pending = CompletableDeferred<kotlinx.serialization.json.JsonElement>()
        var requests = 0
        remotes.handler = { call ->
            if (call.channel != Channels.SESSIONS_SUMMARIES) FakeRemotes.defaultAnswer(call)
            else if (++requests == 1) pending.await()
            else Json.parseToJsonElement("""[{"id":"s1","activeWatchCount":0}]""")
        }
        suspend fun notify(type: String) {
            remote.events.emit(Events.AGENT_EVENT to buildJsonObject { put("sessionId", "s1"); put("type", type) })
            runCurrent()
        }
        notify("session_meta")
        notify("done")
        advanceTimeBy(601); runCurrent()
        assertEquals(1, requests)
        notify("session_meta")
        notify("done")
        pending.complete(Json.parseToJsonElement("""[{"id":"s1","activeWatchCount":1}]"""))
        runCurrent()
        assertEquals(1L, repo.state.value.summaries.single().activeWatchCount)
        advanceTimeBy(601); runCurrent()
        assertEquals(0L, repo.state.value.summaries.single().activeWatchCount)
        assertEquals(2, requests)
        advanceTimeBy(5_000); runCurrent()
        assertEquals(2, requests)
    }

    @Test
    fun `reconnect drops old dirty work and failed summaries only retry on invalidation`() = runTest {
        val remotes = FakeRemotes()
        val repo = repo(remotes = remotes)
        val id = repo.pair(link)
        val old = remotes.last
        old.goOnline(); runCurrent()
        val pending = CompletableDeferred<kotlinx.serialization.json.JsonElement>()
        var oldRequests = 0
        old.handler = { call ->
            if (call.channel != Channels.SESSIONS_SUMMARIES) FakeRemotes.defaultAnswer(call)
            else {
                oldRequests++
                // Simulate a transport that still returns after cancellation.
                withContext(NonCancellable) { pending.await() }
            }
        }
        suspend fun notify(remote: FakeRemote, type: String) {
            remote.events.emit(Events.AGENT_EVENT to buildJsonObject { put("sessionId", "s1"); put("type", type) })
            runCurrent()
        }
        notify(old, "done")
        advanceTimeBy(601); runCurrent()
        notify(old, "session_meta")
        repo.connect(id); runCurrent()
        val fresh = remotes.last
        fresh.goOnline(); runCurrent()
        val freshPending = CompletableDeferred<kotlinx.serialization.json.JsonElement>()
        var freshRequests = 0
        fresh.handler = { call ->
            if (call.channel != Channels.SESSIONS_SUMMARIES) FakeRemotes.defaultAnswer(call)
            else {
                freshRequests++
                if (freshRequests == 1) freshPending.await() else error("failed")
            }
        }
        notify(fresh, "done")
        advanceTimeBy(601); runCurrent()
        pending.complete(Json.parseToJsonElement("""[{"id":"s1","activeWatchCount":99}]"""))
        runCurrent()
        assertTrue(repo.state.value.summaries.isEmpty())
        assertEquals(1, oldRequests)
        notify(fresh, "session_meta")
        advanceTimeBy(601); runCurrent()
        assertEquals(1, freshRequests)
        freshPending.completeExceptionally(IllegalStateException("failed"))
        runCurrent()
        advanceTimeBy(601); runCurrent()
        assertEquals("a pending invalidation survives failure", 2, freshRequests)
        advanceTimeBy(5_000); runCurrent()
        assertEquals("failure alone must not loop", 2, freshRequests)
        notify(fresh, "done")
        advanceTimeBy(601); runCurrent()
        assertEquals(3, freshRequests)
        assertEquals(1, oldRequests)
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
    fun `load connects to the phone's default computer when it is still paired`() = runTest {
        val store = FakeStore()
        val remotes = FakeRemotes()
        val first = repo(store, remotes)
        val a = first.pair(link)
        val b = first.pair(link.copy(relayUrl = "wss://other.example.dev"))
        runCurrent()
        assertEquals(b, first.state.value.activeId) // the last one paired is the last used
        val second = repo(store, remotes)
        second.load(preferredId = a)
        runCurrent()
        assertEquals(a, second.state.value.activeId)
        val third = repo(store, remotes)
        third.load(preferredId = "gone")
        runCurrent()
        assertEquals(a, third.state.value.activeId) // an unknown default falls back to the last used
        val fourth = repo(store, remotes)
        fourth.load()
        runCurrent()
        assertEquals(a, fourth.state.value.activeId) // no default: as before
    }

    @Test
    fun `forgetting a computer tells the phone's other settings`() = runTest {
        val r = repo()
        r.pair(link)
        r.forget("id-1")
        assertEquals(listOf("id-1"), forgotten)
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

    @Test
    fun `loadAllModels asks every enabled provider, keeps going past one that fails, and retries`() = runTest {
        var cloudFails = true
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.PROVIDERS_LIST -> buildJsonArray {
                    listOf("engine" to true, "cloud" to true, "off" to false).forEach { (id, on) ->
                        add(buildJsonObject { put("id", id); put("kind", "openai-compat"); put("label", id.uppercase()); put("enabled", on) })
                    }
                }
                Channels.MODELS_LIST -> when ((c.args.single() as JsonPrimitive).content) {
                    "engine" -> buildJsonArray { add(buildJsonObject { put("id", "qwen"); put("providerId", "engine"); put("name", "Qwen") }) }
                    "cloud" -> if (cloudFails) throw com.nekko.protocol.RelayException("models:list: timed out") else buildJsonArray {
                        add(buildJsonObject { put("id", "opus"); put("providerId", "cloud"); put("name", "Opus") })
                    }
                    else -> error("a disabled provider must not be asked")
                }
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(remotes = remotes)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        assertEquals(3, repo.state.value.providers.size)

        val groups = repo.loadAllModels()
        assertEquals(listOf("engine", "cloud"), groups.map { it.provider.id })
        assertEquals(listOf("qwen"), groups[0].models?.map { it.id })
        assertNull(groups[1].models)
        assertEquals("Didn’t answer in time.", groups[1].error)
        // Each list gets the desktop picker's limit, not the two-minute default.
        assertTrue(remotes.last.calls.filter { it.channel == Channels.MODELS_LIST }.all { it.timeoutMs == 6_000L })

        cloudFails = false
        val again = repo.loadAllModels(force = true)
        assertEquals(listOf("opus"), again[1].models?.map { it.id })
        assertNull(again[1].error)
    }

    @Test
    fun `the computer's phone-settable settings are read, changed, and the reply is what shows`() = runTest {
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.SETTINGS_GET -> buildJsonObject { put("defaultChatMode", "ask"); put("chatPaneAction", "complete") }
                // The computer answers with its reduced view after saving.
                Channels.SETTINGS_UPDATE -> buildJsonObject { put("defaultChatMode", "yolo"); put("chatPaneAction", "complete") }
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(remotes = remotes)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        assertEquals(com.nekko.protocol.PcSettings.ChatMode.ASK, repo.state.value.pcSettings.defaultChatMode)
        repo.updatePcSettings(com.nekko.protocol.PcSettings.patch(mode = com.nekko.protocol.PcSettings.ChatMode.YOLO))
        val sent = remotes.last.calls.last { it.channel == Channels.SETTINGS_UPDATE }
        assertEquals("""{"defaultChatMode":"yolo"}""", sent.args.single().toString())
        assertEquals(com.nekko.protocol.PcSettings.ChatMode.YOLO, repo.state.value.pcSettings.defaultChatMode)
    }

    @Test
    fun `raising the mode on a phone that can't sign is refused in plain words and the old mode stays`() = runTest {
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.SETTINGS_GET -> buildJsonObject { put("defaultChatMode", "ask"); put("chatPaneAction", "complete") }
                Channels.SETTINGS_UPDATE -> throw com.nekko.protocol.RelayException("Not allowed from a paired phone (proof-required): settings:update")
                Channels.CHANGES_LIST -> throw com.nekko.protocol.RelayException("Not allowed from a paired phone (read-off): changes:list")
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(remotes = remotes)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        val name = repo.state.value.active!!.name
        val e = runCatching {
            repo.updatePcSettings(com.nekko.protocol.PcSettings.patch(mode = com.nekko.protocol.PcSettings.ChatMode.YOLO))
        }.exceptionOrNull() as com.nekko.protocol.RelayException
        assertEquals("Confirm with your fingerprint or screen lock to let chats on $name run with fewer approvals.", e.message)
        assertEquals("proof-required", e.refusal?.code)
        assertEquals(com.nekko.protocol.PcSettings.ChatMode.ASK, repo.state.value.pcSettings.defaultChatMode)
        // A read refused by the computer's switch says where to turn it on, for every caller.
        val read = runCatching { repo.caller.call(Channels.CHANGES_LIST, JsonPrimitive("s1")) }.exceptionOrNull()
        assertEquals("Reading from this phone is turned off on $name. Turn it on in Remote access → What phones can do.", read?.message)
    }

    @Test
    fun `raising the mode is sent again signed, after registering this phone's key once`() = runTest {
        val signer = com.nekko.protocol.SoftwareChangeSigner.generate()
        val key = java.util.Base64.getEncoder().encodeToString(kotlinx.coroutines.runBlocking { signer.publicKey() })
        var mode = "ask"
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.SETTINGS_GET -> buildJsonObject { put("defaultChatMode", mode); put("chatPaneAction", "complete") }
                com.nekko.protocol.ChangeProof.KEY_CHANNEL -> buildJsonObject { put("registered", true) }
                Channels.SETTINGS_UPDATE ->
                    if (c.proof == null) throw com.nekko.protocol.RelayException("Not allowed from a paired phone (proof-required): settings:update")
                    else buildJsonObject { put("defaultChatMode", "yolo"); put("chatPaneAction", "complete") }.also { mode = "yolo" }
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(remotes = remotes, signer = signer)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        val yolo = com.nekko.protocol.PcSettings.patch(mode = com.nekko.protocol.PcSettings.ChatMode.YOLO)
        repo.updatePcSettings(yolo)
        assertEquals(com.nekko.protocol.PcSettings.ChatMode.YOLO, repo.state.value.pcSettings.defaultChatMode)

        val sent = remotes.last.calls.filter { it.channel == Channels.SETTINGS_UPDATE || it.channel == com.nekko.protocol.ChangeProof.KEY_CHANNEL }
        assertEquals(listOf(Channels.SETTINGS_UPDATE, com.nekko.protocol.ChangeProof.KEY_CHANNEL, Channels.SETTINGS_UPDATE), sent.map { it.channel })
        assertNull("plain first", sent[0].proof)
        assertEquals(key, sent[1].args.single().jsonPrimitive.content)
        // Each proof is this phone's signature over what was sent, as the computer checks it.
        val deviceId = remotes.last.config.deviceId
        for (c in sent.drop(1)) {
            val p = c.proof!!
            val text = com.nekko.protocol.ChangeProof.payload(deviceId, c.channel, kotlinx.serialization.json.JsonArray(c.args), p["ts"]!!.jsonPrimitive.content.toLong())
            val sig = java.util.Base64.getDecoder().decode(p["sig"]!!.jsonPrimitive.content)
            assertTrue(com.nekko.protocol.ChangeProof.verify(java.util.Base64.getDecoder().decode(key), text, sig))
        }

        // A second raise on the same connection signs again without registering again.
        mode = "guardrails"
        repo.updatePcSettings(yolo)
        assertEquals(1, remotes.last.calls.count { it.channel == com.nekko.protocol.ChangeProof.KEY_CHANNEL })
        assertEquals("the key, then two raises", 3, signer.signatures)
    }

    @Test
    fun `a step-up the computer asks for rides beside the proof`() = runTest {
        val signer = com.nekko.protocol.SoftwareChangeSigner.generate()
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.SETTINGS_GET -> buildJsonObject { put("defaultChatMode", "ask"); put("chatPaneAction", "complete") }
                com.nekko.protocol.ChangeProof.KEY_CHANNEL -> buildJsonObject { put("registered", true) }
                Channels.SETTINGS_UPDATE -> when {
                    c.proof == null -> throw com.nekko.protocol.RelayException("Not allowed from a paired phone (proof-required): settings:update")
                    c.stepUp == null -> throw com.nekko.protocol.RelayException("Not allowed from a paired phone (step-up-required): settings:update")
                    else -> buildJsonObject { put("defaultChatMode", "yolo"); put("chatPaneAction", "complete") }
                }
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(remotes = remotes, signer = signer)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        val yolo = com.nekko.protocol.PcSettings.patch(mode = com.nekko.protocol.PcSettings.ChatMode.YOLO)
        val e = runCatching { repo.updatePcSettings(yolo) }.exceptionOrNull() as com.nekko.protocol.RelayException
        assertTrue("the step-up sheet takes it from here", e.refusal!!.asksForStepUp)
        repo.updatePcSettings(yolo, com.nekko.protocol.StepUpProof.Totp("123456"))
        val last = remotes.last.calls.last()
        assertEquals(Channels.SETTINGS_UPDATE, last.channel)
        assertEquals(com.nekko.protocol.StepUpProof.Totp("123456"), last.stepUp)
        assertTrue(last.proof != null)
        assertEquals(com.nekko.protocol.PcSettings.ChatMode.YOLO, repo.state.value.pcSettings.defaultChatMode)
    }

    @Test
    fun `forgetting the last computer deletes the Change key`() = runTest {
        var forgot = 0
        val signer = object : com.nekko.protocol.ChangeSigner {
            override suspend fun publicKey() = ByteArray(65)
            override suspend fun sign(message: ByteArray) = ByteArray(64)
            override suspend fun forget() { forgot++ }
        }
        val repo = repo(signer = signer)
        repo.pair(link)
        repo.pair(PairingLink("wss://other.example.dev", "ffffffffffffffff", key))
        repo.forget(repo.state.value.computers.first().id)
        assertEquals("another computer still knows the key", 0, forgot)
        repo.forget(repo.state.value.computers.single().id)
        assertEquals(1, forgot)
    }

    @Test
    fun `complete archives and keeps the chat as completed, restore brings it back, delete removes it`() = runTest {
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.SESSIONS_SUMMARIES) buildJsonArray {
                add(buildJsonObject { put("id", "s1"); put("title", "One"); put("updatedAt", 5) })
                add(buildJsonObject { put("id", "s2"); put("title", "Two"); put("updatedAt", 6); put("archivedAt", 7) })
            } else FakeRemotes.defaultAnswer(c)
        }
        val repo = repo(remotes = remotes)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        // Completed chats come down with the active ones.
        assertEquals(listOf("s2", "s1"), repo.state.value.summaries.map { it.id })
        assertTrue(repo.state.value.summaries.first { it.id == "s2" }.archived)

        repo.completeChat("s1")
        val complete = remotes.last.calls.last { it.channel == Channels.SESSION_SET_OPTIONS }
        assertEquals("\"s1\"", complete.args[0].toString())
        assertEquals("""{"archivedAt":1000}""", complete.args[1].toString())
        val s1 = repo.state.value.summaries.first { it.id == "s1" }
        assertTrue(s1.archived)
        assertEquals(1000L, s1.archivedAt)

        repo.restoreChat("s2")
        val restore = remotes.last.calls.last { it.channel == Channels.SESSION_SET_OPTIONS }
        assertEquals("\"s2\"", restore.args[0].toString())
        assertEquals("""{"archivedAt":null}""", restore.args[1].toString())
        assertFalse(repo.state.value.summaries.first { it.id == "s2" }.archived)

        repo.deleteChat("s2")
        assertEquals("\"s2\"", remotes.last.calls.last { it.channel == Channels.SESSION_DELETE }.args.single().toString())
        assertEquals(listOf("s1"), repo.state.value.summaries.map { it.id })
    }

    @Test
    fun `rename and pin change the chat on the computer and in the list`() = runTest {
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.SESSIONS_SUMMARIES) buildJsonArray {
                add(buildJsonObject { put("id", "s1"); put("title", "One"); put("updatedAt", 5); put("pinned", true) })
            } else FakeRemotes.defaultAnswer(c)
        }
        val repo = repo(remotes = remotes)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        assertTrue(repo.state.value.summaries.single().pinned)

        repo.renameChat("s1", "  Release notes \n")
        assertEquals("""{"title":"Release notes"}""", remotes.last.calls.last { it.channel == Channels.SESSION_SET_OPTIONS }.args[1].toString())
        assertEquals("Release notes", repo.state.value.summaries.single().title)
        // A blank title changes nothing.
        val sets = remotes.last.calls.count { it.channel == Channels.SESSION_SET_OPTIONS }
        repo.renameChat("s1", "   ")
        assertEquals(sets, remotes.last.calls.count { it.channel == Channels.SESSION_SET_OPTIONS })

        repo.setPinned("s1", false)
        assertEquals("""{"pinned":false}""", remotes.last.calls.last { it.channel == Channels.SESSION_SET_OPTIONS }.args[1].toString())
        assertFalse(repo.state.value.summaries.single().pinned)
    }

    @Test
    fun `a chat's mode is sent plain to lower it and signed when the computer asks`() = runTest {
        val signer = com.nekko.protocol.SoftwareChangeSigner.generate()
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                com.nekko.protocol.ChangeProof.KEY_CHANNEL -> buildJsonObject { put("registered", true) }
                Channels.SESSION_SET_OPTIONS ->
                    if (c.proof == null && c.args[1].toString().contains("yolo")) throw com.nekko.protocol.RelayException("Not allowed from a paired phone (proof-required): session:setOptions")
                    else buildJsonObject {}
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(remotes = remotes, signer = signer)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()

        repo.setChatMode("s1", com.nekko.protocol.PcSettings.ChatMode.ASK)
        val lower = remotes.last.calls.filter { it.channel == Channels.SESSION_SET_OPTIONS }
        assertEquals(1, lower.size)
        assertNull(lower.single().proof)
        assertEquals("""{"mode":"ask"}""", lower.single().args[1].toString())

        repo.setChatMode("s1", com.nekko.protocol.PcSettings.ChatMode.YOLO)
        val raise = remotes.last.calls.filter { it.channel == Channels.SESSION_SET_OPTIONS }.drop(1)
        assertEquals("plain, then signed", 2, raise.size)
        assertNull(raise[0].proof)
        assertNotNull(raise[1].proof)
        assertEquals("\"s1\"", raise[1].args[0].toString())
    }

    @Test
    fun `each computer keeps its own drafts on disk, and forgetting it deletes them`() = runTest {
        val files = object : com.nekko.protocol.OfflineFiles {
            val map = HashMap<String, JsonElement>()
            override fun load(computerId: String, name: String) = map["$computerId/$name"]
            override fun save(computerId: String, name: String, value: JsonElement) { map["$computerId/$name"] = value }
            override fun remove(computerId: String) { map.keys.removeAll { it.startsWith("$computerId/") } }
        }
        val repo = repo(offline = files)
        val first = repo.pair(link)
        repo.drafts.set("s1", com.nekko.protocol.Draft("half a thought"))
        runCurrent()
        val second = repo.pair(PairingLink("wss://other.example.dev", "ffffffffffffffff", key))
        assertTrue("the other computer starts with none", repo.drafts.drafts.value.isEmpty())
        repo.connect(first)
        assertEquals("half a thought", repo.drafts.draft("s1").text)

        repo.forget(first)
        assertTrue(files.map.keys.none { it.startsWith("$first/") })
        assertEquals(second, repo.state.value.activeId)
        assertTrue(repo.drafts.drafts.value.isEmpty())
    }

    @Test
    fun `check routes says hello on a socket of its own, never with the pairing code, and leaves the live one alone`() = runTest {
        val remotes = FakeRemotes()
        val repo = repo(remotes = remotes)
        repo.pair(link)
        val live = remotes.last
        live.goOnline()
        runCurrent()
        val job = launch { repo.runChecks() }
        runCurrent()
        assertTrue(repo.checking.value)
        val hello = remotes.created.last()
        assertTrue("a socket of its own", hello !== live)
        assertNull("never the pairing code", hello.config.pairCode)
        assertEquals(link.relayUrl, hello.config.relayUrl)
        hello.status.value = com.nekko.protocol.RelayStatus(RelayState.OFFLINE)
        runCurrent()
        job.join()
        val report = repo.checks.value.single()
        assertEquals(true, report.dns?.ok)
        assertEquals(true, report.tcp?.ok)
        assertEquals("The relay answered; $DEFAULT_COMPUTER_NAME isn’t connected to it", report.hello?.detail)
        assertTrue("closed once answered", hello.closed)
        assertFalse(live.closed)
        assertFalse(repo.checking.value)
        val text = repo.diagnosticsText("test")
        assertFalse(text.contains(link.room))
        assertFalse(text.contains(key))
    }

    @Test
    fun `coming back to the app re-reads the chat list`() = runTest {
        val remotes = FakeRemotes()
        val repo = repo(remotes = remotes)
        repo.pair(link)
        remotes.last.goOnline()
        runCurrent()
        val before = remotes.last.channels().count { it == Channels.SESSIONS_SUMMARIES }
        repo.nudge()
        advanceTimeBy(601)
        runCurrent()
        assertEquals(before + 1, remotes.last.channels().count { it == Channels.SESSIONS_SUMMARIES })
    }

    @Test
    fun `the computer's theme comes from settings and then follows the live event`() = runTest {
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.SETTINGS_GET -> buildJsonObject { put("theme", "light"); put("accent", "#6D5EFC"); put("hfToken", "hf_secret") }
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(remotes = remotes)
        repo.pair(link)
        assertNull(repo.state.value.appearance)
        remotes.last.goOnline()
        runCurrent()
        assertEquals(com.nekko.protocol.Appearance.ThemeMode.LIGHT, repo.state.value.appearance?.theme)
        assertEquals(0xFF6D5EFCL, repo.state.value.appearance?.accent)

        remotes.last.events.emit(Events.APPEARANCE_UPDATED to buildJsonObject { put("theme", "dark"); put("accent", "#fb923c") })
        runCurrent()
        assertEquals(com.nekko.protocol.Appearance.ThemeMode.DARK, repo.state.value.appearance?.theme)
        assertEquals(0xFFFB923CL, repo.state.value.appearance?.accent)
    }
}
