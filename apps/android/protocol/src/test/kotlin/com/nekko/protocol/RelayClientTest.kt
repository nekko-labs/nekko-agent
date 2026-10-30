package com.nekko.protocol

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The relay client against an in-memory relay + agent. The fake plays the
 * computer's side of `crates/nekko-remote/src/agent.rs`: it challenges each connection,
 * opens sealed frames with the room key, answers a HELLO that carries its
 * challenge, checks every request's seq and challenge (re-challenging on a bad
 * one, like the computer), and replies to requests. With [FakeRelay.challenges]
 * off it is a computer from before protocol 4.
 */
class RelayClientTest {
    private val key = E2E.randomBytes(32)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun tearDown() = scope.cancel()

    /** An agent that knows [known] devices and accepts [code] once. */
    inner class FakeRelay(var known: MutableSet<String> = mutableSetOf(), var code: String? = null) : WsTransport {
        val urls = CopyOnWriteArrayList<String>()
        val hellos = CopyOnWriteArrayList<JsonObject>()
        val requests = CopyOnWriteArrayList<JsonObject>()
        var current: Conn? = null
        var refuseNext: Pair<Int, String>? = null
        /** `host:port` of routes that don't work: true hangs (never opens), false refuses at once. */
        val unreachable = java.util.concurrent.ConcurrentHashMap<String, Boolean>()
        /** The computer's phone protocol version in its welcome (IO-32); null sends none. */
        var welcomeProtocol: Int? = null
        /** Protocol 4: challenge each connection and hold HELLOs and requests to it. */
        var challenges = true
        /** Requests the computer dropped for a bad seq or challenge. */
        val rejected = CopyOnWriteArrayList<JsonObject>()
        var answer: (JsonObject) -> JsonObject? = { req -> buildJsonObject { put("type", "res"); put("id", req["id"]!!); put("result", JsonPrimitive("ok:${req["channel"]!!.jsonPrimitive.content}")) } }

        inner class Conn(val listener: WsListener) : WsConnection {
            @Volatile var open = true
            /** The challenge this connection must answer next, or null once answered. */
            @Volatile var issued: String? = null
            /** The challenge the welcomed HELLO answered, and the last seq seen since. */
            @Volatile var welcomedWith: String? = null
            @Volatile var lastSeq = 0L
            private var n = 0

            /** Seal a fresh challenge to this connection, as the computer does on client-open. */
            fun challenge(): String {
                val c = "challenge-${++n}-${E2E.toHex(E2E.randomBytes(4))}"
                issued = c
                welcomedWith = null
                lastSeq = 0
                push(buildJsonObject { put("type", "challenge"); put("challenge", c) })
                return c
            }

            override fun send(text: String): Boolean {
                if (!open) return false
                val env = WireJson.parseToJsonElement(text).jsonObject
                val frame = E2E.open(key, env["enc"]!!.jsonPrimitive.content).jsonObject
                when (frame["type"]!!.jsonPrimitive.content) {
                    "hello" -> {
                        hellos += frame
                        if (challenges) {
                            val answered = frame["challenge"]?.jsonPrimitive?.content
                            if (answered == null || answered != issued) { challenge(); return true }
                            issued = null
                            welcomedWith = answered
                            lastSeq = 0
                        }
                        val id = frame["deviceId"]!!.jsonPrimitive.content
                        val pair = frame["pair"]?.jsonPrimitive?.content
                        val reply = when {
                            id in known -> null
                            pair != null && pair == code -> { known += id; code = null; null }
                            pair != null -> "bad-code"
                            else -> "unknown-device"
                        }
                        if (reply == null) push(buildJsonObject {
                            put("type", "welcome")
                            put("device", buildJsonObject { put("id", id); put("name", frame["name"]!!); put("platform", "android") })
                            welcomeProtocol?.let { put("protocol", it) }
                        }) else {
                            push(buildJsonObject { put("type", "denied"); put("reason", reply) })
                            drop(4001, "kicked by agent")
                        }
                    }
                    "req" -> {
                        val seq = frame["seq"]?.jsonPrimitive?.content?.toLong()
                        val ch = frame["challenge"]?.jsonPrimitive?.content
                        if (seq == null || seq <= lastSeq || (challenges && ch != welcomedWith)) {
                            rejected += frame
                            if (challenges) challenge()
                            return true
                        }
                        lastSeq = seq
                        requests += frame
                        answer(frame)?.let { push(it) }
                    }
                }
                return true
            }
            override fun close(code: Int, reason: String) { if (open) { open = false; listener.onClosed(code, reason) } }
            fun push(frame: JsonObject) = listener.onMessage(buildJsonObject { put("enc", E2E.seal(key, frame)) }.toString())
            fun plain(frame: JsonObject) = listener.onMessage(frame.toString())
            fun drop(code: Int, reason: String) { if (open) { open = false; listener.onClosed(code, reason) } }
        }

        override fun open(url: String, listener: WsListener): WsConnection {
            urls += url
            val c = Conn(listener)
            when (unreachable[url.substringAfter("://").substringBefore('/')]) {
                true -> return c
                false -> { scope.launchSoon { c.drop(1006, "connection refused") }; return c }
                null -> {}
            }
            current = c
            refuseNext?.let { (code, reason) ->
                refuseNext = null
                scope.launchSoon { c.drop(code, reason) }
                return c
            }
            scope.launchSoon {
                listener.onOpen()
                if (challenges) c.challenge()
            }
            return c
        }
    }

    private fun CoroutineScope.launchSoon(block: () -> Unit) = async { delay(5); block() }

    private fun client(relay: FakeRelay, pair: String? = null, id: String = "dev-1", transport: WsTransport = relay, challengeWaitMs: Long = 2_000) = RelayClient(
        RelayConfig(
            relayUrl = "wss://relay.test/", room = "abcd1234", key = "k&ey", keyBytes = key,
            deviceId = id, deviceName = "Pixel", pairCode = pair,
            // Generous: the first test on a cold JVM also pays for crypto setup, and no test here
            // waits for these to expire, so they only bound how long a real failure takes.
            handshakeTimeoutMs = 10_000, requestTimeoutMs = 10_000, retryBaseMs = 20, retryMaxMs = 80, offlinePollMs = 40,
            challengeWaitMs = challengeWaitMs,
        ),
        transport, scope,
    )

    private suspend fun RelayClient.await(state: RelayState) = withTimeout(10_000) { status.first { it.state == state } }

    private suspend fun until(what: String, cond: () -> Boolean) {
        try {
            withTimeout(5_000) { while (!cond()) delay(5) }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            fail("timed out waiting for $what")
        }
    }

    /** crates/nekko-remote/tests/golden/relay-handshake.json, shared with the computer and the iPhone. */
    private val fixture: JsonObject by lazy {
        val root = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..")
        Json.parseToJsonElement(File(root, "crates/nekko-remote/tests/golden/relay-handshake.json").readText()).jsonObject
    }
    private fun fx(k: String) = fixture[k]!!.jsonPrimitive.content
    private fun fxObj(k: String) = fixture[k]!!.jsonObject

    /** Records what the phone sends on each socket; the test plays the computer. Requests are answered. */
    inner class Recorder(private val k: ByteArray) : WsTransport {
        val sockets = CopyOnWriteArrayList<Sock>()
        val last get() = sockets.last()

        inner class Sock(val listener: WsListener) : WsConnection {
            val sent = CopyOnWriteArrayList<JsonObject>()
            @Volatile var open = true
            override fun send(text: String): Boolean {
                if (!open) return false
                val frame = E2E.open(k, WireJson.parseToJsonElement(text).jsonObject["enc"]!!.jsonPrimitive.content).jsonObject
                sent += frame
                if (frame["type"]!!.jsonPrimitive.content == "req") {
                    push(buildJsonObject { put("type", "res"); put("id", frame["id"]!!); put("result", "ok") })
                }
                return true
            }
            override fun close(code: Int, reason: String) { if (open) { open = false; listener.onClosed(code, reason) } }
            fun push(frame: JsonObject) = listener.onMessage(buildJsonObject { put("enc", E2E.seal(k, frame)) }.toString())
            fun of(type: String) = sent.filter { it["type"]!!.jsonPrimitive.content == type }
        }

        override fun open(url: String, listener: WsListener): WsConnection {
            val s = Sock(listener)
            sockets += s
            scope.launchSoon { listener.onOpen() }
            return s
        }
    }

    private fun fixtureClient(t: WsTransport, challengeWaitMs: Long = 2_000): RelayClient {
        val d = fxObj("device")
        return RelayClient(
            RelayConfig(
                relayUrl = "wss://relay.test", room = fx("room"), key = fx("secret"), keyBytes = E2E.fromHex(fx("key")),
                deviceId = d["deviceId"]!!.jsonPrimitive.content, deviceName = d["name"]!!.jsonPrimitive.content,
                platform = d["platform"]!!.jsonPrimitive.content,
                handshakeTimeoutMs = 10_000, requestTimeoutMs = 10_000, retryBaseMs = 20, retryMaxMs = 80, offlinePollMs = 40,
                challengeWaitMs = challengeWaitMs,
            ),
            t, scope,
        )
    }

    private fun Recorder.Sock.welcome() = push(buildJsonObject {
        put("type", "welcome")
        put("device", buildJsonObject { put("id", "x"); put("name", "Test phone"); put("platform", "android") })
    })

    @Test fun `answers the shared challenge with the shared HELLO, then sends the shared requests`() = runBlocking {
        assertEquals(fx("key"), E2E.toHex(E2E.deriveKey(fx("secret"), fx("room"))))
        assertEquals(PhoneProtocol.VERSION, fixture["protocol"]!!.jsonPrimitive.content.toInt())
        val t = Recorder(E2E.fromHex(fx("key")))
        val c = fixtureClient(t)
        c.connect()
        until("the socket") { t.sockets.isNotEmpty() }
        delay(150)
        assertTrue("no HELLO before the challenge", t.last.sent.isEmpty())

        t.last.listener.onMessage(buildJsonObject { put("enc", fxObj("challenge")["blob"]!!) }.toString())
        until("the HELLO") { t.last.of("hello").isNotEmpty() }
        assertEquals(fxObj("hello"), t.last.of("hello").single())

        t.last.welcome()
        c.await(RelayState.ONLINE)
        c.call(Channels.SESSIONS_SUMMARIES)
        c.call(Channels.SESSION_GET, JsonPrimitive("s1"))
        assertEquals(fixture["requests"]!!.jsonArray, JsonArray(t.last.of("req")))
        c.close()
    }

    @Test fun `a step-up rides inside the sealed request beside the usual fields`() = runBlocking {
        val t = Recorder(E2E.fromHex(fx("key")))
        val c = fixtureClient(t)
        c.connect()
        until("the socket") { t.sockets.isNotEmpty() }
        t.last.listener.onMessage(buildJsonObject { put("enc", fxObj("challenge")["blob"]!!) }.toString())
        until("the HELLO") { t.last.of("hello").isNotEmpty() }
        t.last.welcome()
        c.await(RelayState.ONLINE)
        val patch = buildJsonObject { put("defaultChatMode", "yolo") }
        c.call(Channels.SETTINGS_UPDATE, patch)
        c.callWithStepUp(StepUpProof.Totp("123456"), Channels.SETTINGS_UPDATE, patch)
        val (plain, stepped) = t.last.of("req")
        assertNull("no step-up unless asked", plain["stepUp"])
        assertEquals(buildJsonObject { put("totp", "123456") }, stepped["stepUp"])
        assertEquals(plain["challenge"], stepped["challenge"])
        assertEquals(plain["seq"]!!.jsonPrimitive.content.toLong() + 1, stepped["seq"]!!.jsonPrimitive.content.toLong())
        assertEquals(JsonArray(listOf(patch)), stepped["args"])
        assertEquals(Channels.SETTINGS_UPDATE, stepped["channel"]!!.jsonPrimitive.content)
        assertNull("no proof unless signed", stepped["proof"])
        c.close()
    }

    @Test fun `a Change proof rides inside the sealed request, with a step-up beside it when asked`() = runBlocking {
        val t = Recorder(E2E.fromHex(fx("key")))
        val c = fixtureClient(t)
        c.connect()
        until("the socket") { t.sockets.isNotEmpty() }
        t.last.listener.onMessage(buildJsonObject { put("enc", fxObj("challenge")["blob"]!!) }.toString())
        until("the HELLO") { t.last.of("hello").isNotEmpty() }
        t.last.welcome()
        c.await(RelayState.ONLINE)
        val args = JsonArray(listOf(buildJsonObject { put("defaultChatMode", "yolo") }))
        val proof = buildJsonObject { put("ts", 1_760_000_000_000); put("sig", "c2ln") }
        c.callSigned(Channels.SETTINGS_UPDATE, args, proof)
        c.callSigned(Channels.SETTINGS_UPDATE, args, proof, StepUpProof.Totp("123456"))
        val (signed, both) = t.last.of("req")
        assertEquals(proof, signed["proof"])
        assertNull(signed["stepUp"])
        assertEquals(args, signed["args"])
        assertEquals(proof, both["proof"])
        assertEquals(buildJsonObject { put("totp", "123456") }, both["stepUp"])
        c.close()
    }

    @Test fun `a computer that never challenges gets the legacy HELLO and seq-only requests`() = runBlocking {
        val t = Recorder(E2E.fromHex(fx("key")))
        val c = fixtureClient(t, challengeWaitMs = 100)
        c.connect()
        until("the legacy HELLO") { t.sockets.isNotEmpty() && t.last.of("hello").isNotEmpty() }
        assertEquals(fxObj("legacyHello"), t.last.of("hello").single())

        t.last.welcome()
        c.await(RelayState.ONLINE)
        c.call(Channels.SESSIONS_SUMMARIES)
        c.call(Channels.SESSION_GET, JsonPrimitive("s1"))
        val want = fixture["requests"]!!.jsonArray.map { JsonObject(it.jsonObject - "challenge") }
        assertEquals(want, t.last.of("req"))
        c.close()
    }

    @Test fun `a challenge while online restarts the handshake and seq, keeping calls in flight`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        c.call(Channels.APP_INFO)
        val first = relay.hellos.single()["challenge"]!!.jsonPrimitive.content

        relay.answer = { null } // hold the next call
        val inflight = async { runCatching { c.call(Channels.CHAT_PENDING) } }
        until("the held request") { relay.requests.size == 2 }
        val held = relay.requests[1]
        assertEquals(2L, held["seq"]!!.jsonPrimitive.content.toLong())

        val second = relay.current!!.challenge()
        assertEquals(2, relay.hellos.size)
        assertEquals(second, relay.hellos[1]["challenge"]!!.jsonPrimitive.content)
        assertTrue(first != second)
        c.await(RelayState.ONLINE)
        delay(50)
        assertTrue("the call in flight stays pending", inflight.isActive)
        relay.current!!.push(buildJsonObject { put("type", "res"); put("id", held["id"]!!); put("result", "late") })
        assertEquals("late", inflight.await().getOrThrow().jsonPrimitive.content)

        relay.answer = { req -> buildJsonObject { put("type", "res"); put("id", req["id"]!!); put("result", "ok") } }
        c.call(Channels.APP_INFO)
        c.call(Channels.APP_INFO)
        val after = relay.requests.drop(2)
        assertEquals(listOf(1L, 2L), after.map { it["seq"]!!.jsonPrimitive.content.toLong() })
        assertTrue(after.all { it["challenge"]!!.jsonPrimitive.content == second })
        assertTrue("the computer never had to refuse a request", relay.rejected.isEmpty())
        c.close()
    }

    @Test fun `once challenged, a socket without a challenge is dialed again instead of falling back`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay, challengeWaitMs = 100)
        c.connect()
        c.await(RelayState.ONLINE)
        relay.challenges = false // a relay that hides the computer's challenge
        relay.current!!.drop(1006, "network")
        until("two sockets without a challenge") { relay.urls.size >= 3 }
        assertEquals("never a HELLO without a challenge", 1, relay.hellos.size)
        assertTrue(relay.hellos.all { it["challenge"] != null && it["protocol"]!!.jsonPrimitive.content == "4" })

        relay.challenges = true
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.hellos.size)
        assertTrue(relay.hellos.all { it["challenge"] != null })
        c.close()
    }

    @Test fun `a refusal from the computer is parsed off the error`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.answer = { req -> buildJsonObject { put("type", "res"); put("id", req["id"]!!); put("error", "Not allowed from a paired phone (read-off): sessions:summaries") } }
        val c = client(relay)
        c.connect()
        val e = runCatching { c.call(Channels.SESSIONS_SUMMARIES) }.exceptionOrNull() as RelayException
        assertEquals(PhoneRefusal("read-off", "sessions:summaries"), e.refusal)
        assertEquals("Not allowed from a paired phone (read-off): sessions:summaries", e.message)
        c.close()
    }

    @Test fun `enrolls with the one-time code, then never resends it`() = runBlocking {
        val relay = FakeRelay(code = "ABCD2345")
        val c = client(relay, pair = "ABCD2345")
        c.connect()
        c.await(RelayState.ONLINE)
        assertEquals("wss://relay.test/relay?role=client&room=abcd1234&key=k%26ey", relay.urls.single())
        assertEquals("ABCD2345", relay.hellos.single()["pair"]!!.jsonPrimitive.content)
        assertEquals("Pixel", c.welcome.first().name)

        // Drop the socket: the reconnect HELLO must not carry the spent code.
        relay.current!!.drop(1006, "network")
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.hellos.size)
        assertNull(relay.hellos[1]["pair"])
        c.close()
    }

    @Test fun `a newer computer and relay, the welcome field and the relay push frames are ignored`() = runBlocking {
        // iOS reads these (IO-30, IO-32); this client must carry on as before.
        val relay = FakeRelay(known = mutableSetOf("dev-1")).apply { welcomeProtocol = 2 }
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        assertEquals("Pixel", c.welcome.first().name)
        relay.current!!.plain(buildJsonObject { put("type", "push-registered"); put("delivers", true) })
        relay.current!!.plain(buildJsonObject { put("type", "dismiss"); put("tag", "a".repeat(32)) })
        assertEquals("ok:app:info", c.call(Channels.APP_INFO, JsonPrimitive("x")).jsonPrimitive.content)
        assertEquals(RelayState.ONLINE, c.status.first().state)
        assertEquals(1, relay.hellos.size)
        c.close()
    }

    @Test fun `calls channels with sealed requests and resolves replies`() = runBlocking {
        val c = client(FakeRelay(known = mutableSetOf("dev-1")))
        c.connect()
        val r = c.call(Channels.APP_INFO, JsonPrimitive("x"))
        assertEquals("ok:app:info", r.jsonPrimitive.content)
        c.close()
    }

    @Test fun `waits for the handshake before sending a request`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        val r = async { c.call(Channels.SESSIONS_SUMMARIES) }
        assertEquals("ok:sessions:summaries", r.await().jsonPrimitive.content)
        assertEquals(1, relay.requests.size)
        assertEquals(0, relay.requests.single()["args"]!!.jsonArray.size)
        c.close()
    }

    @Test fun `a socket that opens before open() returns still says hello`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        // Like OkHttp on a fast network: onOpen on another thread while open() is still returning.
        val early = object : WsTransport {
            override fun open(url: String, listener: WsListener): WsConnection {
                val c = relay.open(url, object : WsListener {
                    override fun onOpen() {}
                    override fun onMessage(text: String) = listener.onMessage(text)
                    override fun onClosed(code: Int, reason: String) = listener.onClosed(code, reason)
                })
                Thread { listener.onOpen() }.start()
                Thread.sleep(50) // the callback is already waiting when open() returns
                return c
            }
        }
        val c = client(relay, transport = early)
        c.connect()
        assertEquals("ok:app:info", c.call(Channels.APP_INFO).jsonPrimitive.content)
        assertEquals(1, relay.hellos.size)
        c.close()
    }

    @Test fun `host errors reject the call`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.answer = { req -> buildJsonObject { put("type", "res"); put("id", req["id"]!!); put("error", "no such session") } }
        val c = client(relay)
        c.connect()
        try { c.call(Channels.SESSION_GET, JsonPrimitive("s")); fail() } catch (e: RelayException) { assertEquals("no such session", e.message) }
        c.close()
    }

    @Test fun `delivers events and ignores frames sealed with another key`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        val got = async { withTimeout(2_000) { c.events.first() } }
        delay(20)
        relay.current!!.listener.onMessage(buildJsonObject { put("enc", E2E.seal(E2E.randomBytes(32), buildJsonObject { put("type", "event") })) }.toString())
        relay.current!!.listener.onMessage("not json")
        relay.current!!.push(buildJsonObject {
            put("type", "event"); put("channel", Events.AGENT_EVENT)
            put("payload", buildJsonObject { put("type", "text"); put("sessionId", "s"); put("delta", "hi") })
        })
        val (ch, payload) = got.await()
        assertEquals(Events.AGENT_EVENT, ch)
        assertEquals(AgentEvent.Text("s", "hi"), AgentEvent.from(payload))
        c.close()
    }

    @Test fun `a stranger is denied and stays denied`() = runBlocking {
        val relay = FakeRelay()
        val c = client(relay)
        c.connect()
        val s = c.await(RelayState.DENIED)
        assertEquals(DenyReason.UNKNOWN_DEVICE, s.denied)
        delay(150)
        assertEquals(1, relay.urls.size) // no reconnect loop after a denial
        try { c.call(Channels.APP_INFO); fail() } catch (e: RelayException) { assertTrue(e.message!!.contains("no longer paired")) }
    }

    @Test fun `a wrong pairing code is denied as bad-code`() = runBlocking {
        val c = client(FakeRelay(code = "RIGHT234"), pair = "WRONG234")
        c.connect()
        assertEquals(DenyReason.BAD_CODE, c.await(RelayState.DENIED).denied)
    }

    @Test fun `revocation mid-connection (kick 4001) is terminal and fails in-flight calls`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.answer = { null } // never answer
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        val inflight = async { runCatching { c.call(Channels.CHAT_PENDING) } }
        delay(50)
        relay.current!!.drop(4001, "kicked by agent")
        assertEquals(DenyReason.KICKED, c.await(RelayState.DENIED).denied)
        assertTrue(inflight.await().exceptionOrNull() is RelayException)
    }

    @Test fun `a bad pairing key is terminal`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.refuseNext = 1008 to "bad pairing key"
        val c = client(relay)
        c.connect()
        assertEquals(DenyReason.BAD_KEY, c.await(RelayState.DENIED).denied)
    }

    @Test fun `an offline computer is polled, then the handshake completes`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.refuseNext = 1008 to "room not paired (agent offline)"
        val c = client(relay)
        c.connect()
        c.await(RelayState.OFFLINE)
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.urls.size)
        c.close()
    }

    @Test fun `agent-offline then agent-online repeats the handshake on the same socket`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        relay.current!!.plain(buildJsonObject { put("type", "agent-offline") })
        c.await(RelayState.OFFLINE)
        relay.current!!.plain(buildJsonObject { put("type", "agent-online") })
        relay.current!!.challenge() // the computer that rejoined challenges this socket
        c.await(RelayState.ONLINE)
        assertEquals(1, relay.urls.size)
        assertEquals(2, relay.hellos.size)
        c.close()
    }

    @Test fun `reconnect drops a live socket and dials a fresh one`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.answer = { null } // never answer: the call must fail, not hang
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        val old = relay.current!!
        val inflight = async { runCatching { c.call(Channels.CHAT_PENDING) } }
        delay(50)
        c.reconnect()
        assertTrue(inflight.await().exceptionOrNull() is RelayException)
        assertTrue(!old.open)
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.urls.size)
        assertEquals(2, relay.hellos.size)
        // The old socket's late close must not schedule another dial.
        delay(150)
        assertEquals(2, relay.urls.size)
        c.close()
    }

    @Test fun `reconnect skips the backoff while the relay is unreachable`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.refuseNext = 1006 to "network down"
        val c = RelayClient(
            RelayConfig(
                relayUrl = "wss://relay.test/", room = "abcd1234", key = "k", keyBytes = key, deviceId = "dev-1", deviceName = "Pixel",
                handshakeTimeoutMs = 2_000, requestTimeoutMs = 2_000, retryBaseMs = 60_000, retryMaxMs = 60_000,
            ),
            relay, scope,
        )
        c.connect()
        withTimeout(2_000) { c.status.first { it.state == RelayState.CONNECTING && it.detail == "network down" } }
        c.reconnect() // without it the next try would be a minute away
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.urls.size)
        c.close()
    }

    @Test fun `reconnect does nothing once closed or denied`() = runBlocking {
        val closed = FakeRelay(known = mutableSetOf("dev-1"))
        val a = client(closed)
        a.connect(); a.await(RelayState.ONLINE); a.close()
        a.reconnect()
        delay(100)
        assertEquals(1, closed.urls.size)
        assertEquals(RelayState.IDLE, a.state)

        val stranger = FakeRelay()
        val b = client(stranger)
        b.connect(); b.await(RelayState.DENIED)
        b.reconnect()
        delay(100)
        assertEquals(1, stranger.urls.size)
        assertEquals(RelayState.DENIED, b.state)
    }

    @Test fun `close stops reconnecting and rejects new calls`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        c.close()
        assertEquals(RelayState.IDLE, c.state)
        delay(150)
        assertEquals(1, relay.urls.size)
        try { c.call(Channels.APP_INFO); fail() } catch (e: RelayException) { assertEquals("Not connected.", e.message) }
    }

    // AN-28: the client against the fake relay, with two routes to it.

    private val lanRoute = "ws://192.168.1.20:4400"
    private val tailnetRoute = "ws://studio.tail1234.ts.net:4400"

    class FakeProber : RouteProber {
        @Volatile var up = true
        val probes = CopyOnWriteArrayList<String>()
        override suspend fun reachable(relayUrl: String, timeoutMs: Long): Boolean { probes += relayUrl; return up }
    }

    private fun twoRoutes(relay: FakeRelay, prober: RouteProber? = null, dwellMs: Long = 50, allowed: (String) -> Boolean = { true }) = RelayClient(
        RelayConfig(
            relayUrl = tailnetRoute, room = "abcd1234", key = "k", keyBytes = key, deviceId = "dev-1", deviceName = "Pixel",
            handshakeTimeoutMs = 2_000, requestTimeoutMs = 5_000, retryBaseMs = 20, retryMaxMs = 80, offlinePollMs = 40,
            alts = listOf(lanRoute),
            routeRules = RouteRules(openTimeoutMs = 100, probeIntervalMs = 20, failureCooldownMs = 100, minDwellMs = dwellMs, successesToReturn = 3),
            routeAllowed = allowed,
        ),
        relay, scope, prober,
    )

    private suspend fun RelayClient.awaitStatus(timeoutMs: Long = 5_000, cond: (RelayStatus) -> Boolean) =
        withTimeout(timeoutMs) { status.first(cond) }

    private suspend fun RelayClient.awaitOn(route: String, timeoutMs: Long = 5_000) =
        awaitStatus(timeoutMs) { it.state == RelayState.ONLINE && it.route == route }

    @Test fun `prefers the LAN when it answers`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = twoRoutes(relay)
        c.connect()
        val s = c.await(RelayState.ONLINE)
        assertEquals(lanRoute, s.route)
        assertEquals(lanRoute, c.route)
        assertTrue(relay.urls.first().startsWith("$lanRoute/relay?"))
        c.close()
    }

    @Test fun `a hanging LAN falls back to the tailnet within the open timeout`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.unreachable["192.168.1.20:4400"] = true
        val c = twoRoutes(relay)
        val start = System.currentTimeMillis()
        c.connect()
        val s = c.await(RelayState.ONLINE)
        assertEquals(tailnetRoute, s.route)
        assertTrue("not the transport's own timeout", System.currentTimeMillis() - start < 1_500)
        assertEquals("ok:app:info", c.call("app:info").jsonPrimitive.content)
        c.close()
    }

    @Test fun `a refusing LAN falls back at once`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.unreachable["192.168.1.20:4400"] = false
        val c = twoRoutes(relay)
        c.connect()
        assertEquals(tailnetRoute, c.await(RelayState.ONLINE).route)
        assertEquals(2, relay.urls.size)
        c.close()
    }

    @Test fun `leaving the LAN moves to the tailnet, then back when it answers again`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val prober = FakeProber().apply { up = false }
        val c = twoRoutes(relay, prober)
        c.connect()
        c.awaitOn(lanRoute)
        // The LAN goes away under an open socket.
        relay.unreachable["192.168.1.20:4400"] = true
        relay.current!!.drop(1006, "network down")
        c.awaitOn(tailnetRoute)
        // Probes keep failing: it stays put.
        delay(300)
        assertEquals(tailnetRoute, c.route)
        assertTrue("the LAN is probed once its cooldown ends", prober.probes.isNotEmpty())
        assertTrue(prober.probes.all { it == lanRoute })
        // The LAN is back: three good probes and the dwell, then it moves.
        relay.unreachable.clear()
        prober.up = true
        c.awaitOn(lanRoute)
        c.close()
    }

    @Test fun `never changes route under a request in flight`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.unreachable["192.168.1.20:4400"] = false
        // chat:send answers only when the turn is over: here, never.
        relay.answer = { req ->
            if (req["channel"]!!.jsonPrimitive.content == "chat:send") null
            else buildJsonObject { put("type", "res"); put("id", req["id"]!!); put("result", "ok") }
        }
        val c = twoRoutes(relay, FakeProber())
        c.connect()
        c.awaitOn(tailnetRoute)
        relay.unreachable.clear()
        val turn = async { runCatching { c.callWithTimeout(1_000, "chat:send") } }
        delay(600)
        assertEquals("a running turn is never cut to change route", tailnetRoute, c.route)
        turn.await()
        c.awaitOn(lanRoute)
        c.close()
    }

    @Test fun `on cellular it dials the tailnet, and back on Wi-Fi the LAN`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = twoRoutes(relay)
        c.connect()
        c.awaitOn(lanRoute)
        c.networkChanged(NetworkPath.CELLULAR)
        c.awaitOn(tailnetRoute)
        c.networkChanged(NetworkPath.LOCAL)
        c.awaitOn(lanRoute)
        // The first report of where the phone already is changes nothing.
        val dials = relay.urls.size
        c.setNetworkPath(NetworkPath.LOCAL)
        delay(100)
        assertEquals(dials, relay.urls.size)
        c.close()
    }

    @Test fun `an offline computer is not a route failure`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.refuseNext = 1008 to "room not paired (agent offline)"
        val c = twoRoutes(relay)
        c.connect()
        assertEquals("the relay answered on the LAN; the computer is away, not the path", lanRoute, c.await(RelayState.OFFLINE).route)
        c.awaitOn(lanRoute)
        c.close()
    }

    @Test fun `a route this phone may not dial is never dialed`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val prober = FakeProber()
        val c = twoRoutes(relay, prober, allowed = { !it.startsWith("ws://192.168.") })
        c.connect()
        assertEquals(tailnetRoute, c.await(RelayState.ONLINE).route)
        assertEquals(listOf(lanRoute to false, tailnetRoute to true), c.allRoutes)
        relay.current!!.drop(1006, "network down")
        c.awaitOn(tailnetRoute)
        delay(200)
        assertTrue(relay.urls.all { it.startsWith("$tailnetRoute/relay?") })
        assertTrue("nothing better to probe", prober.probes.isEmpty())
        c.close()
    }
}
