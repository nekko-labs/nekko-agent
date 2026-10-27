package com.nekko.android

import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PendingSignOut
import com.nekko.android.data.SignOutOutbox
import com.nekko.protocol.Channels
import com.nekko.protocol.PairingLink
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.StepUpMethod
import com.nekko.protocol.StepUpProof
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The phone's safety exits (SK-8) and the step-up calls (SK-7) through the
 * repository: what is sent, what is forgotten, what waits for the next start.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SafetyExitsTest {
    private val room = "a1b2c3d4e5f60718"
    private val key = "00112233445566778899aabbccddeeff"
    private val link = PairingLink("wss://relay.example.dev", room, key)
    private val derived = ByteArray(32) { it.toByte() }
    private var clock = 1_000L

    private fun TestScope.repo(store: FakeStore, remotes: FakeRemotes): ComputersRepository {
        var n = 0
        return ComputersRepository(
            store = store,
            remotes = remotes,
            scope = backgroundScope,
            deviceName = { "Pixel Test" },
            deriveKey = { _, _ -> derived },
            newId = { "id-${++n}" },
            now = { clock },
            changeSigner = com.nekko.protocol.SoftwareChangeSigner.generate(),
        )
    }

    @Test fun `signing out while online tells the computer and forgets it here`() = runTest {
        val store = FakeStore()
        val remotes = FakeRemotes()
        val repo = repo(store, remotes)
        val id = repo.pair(link)
        runCurrent()
        remotes.last.goOnline()
        runCurrent()
        assertEquals(ComputersRepository.SignOutResult.SENT, repo.signOutThisPhone())
        assertTrue(Channels.DEVICE_SIGN_OUT in remotes.last.channels())
        assertNull(store.map[ComputersRepository.secretKey(id)])
        assertNull("nothing left to send", store.map[SignOutOutbox.KEY])
        assertTrue(repo.state.value.computers.isEmpty())
    }

    @Test fun `signing out offline forgets now and says it at the next start`() = runTest {
        val store = FakeStore()
        val repo = repo(store, FakeRemotes())
        val id = repo.pair(link)
        runCurrent()
        assertEquals(ComputersRepository.SignOutResult.QUEUED, repo.signOutThisPhone())
        assertNull(store.map[ComputersRepository.secretKey(id)])
        assertTrue(repo.state.value.computers.isEmpty())
        val queued = SignOutOutbox(store).list().single()
        assertEquals(room, queued.room)
        assertEquals(store.map[ComputersRepository.DEVICE_KEY], queued.deviceId)
        assertFalse("the outbox is not the index", store.map.getValue(ComputersRepository.INDEX_KEY).contains(key))

        // Next start: a connection of its own to that computer, the sign-out, then nothing kept.
        val later = FakeRemotes()
        val again = repo(store, later)
        again.load()
        runCurrent()
        val r = later.last
        assertEquals(room, r.config.room)
        assertNull("never the pairing code", r.config.pairCode)
        r.goOnline()
        runCurrent()
        assertEquals(listOf(Channels.DEVICE_SIGN_OUT), r.channels())
        assertTrue(r.closed)
        assertNull(store.map[SignOutOutbox.KEY])
    }

    @Test fun `a computer that already refuses the phone counts as signed out`() = runTest {
        val store = FakeStore()
        SignOutOutbox(store).add(PendingSignOut("wss://r", room, key, "00", "dev", clock))
        val later = FakeRemotes()
        repo(store, later).load()
        runCurrent()
        later.last.status.value = RelayStatus(RelayState.DENIED, "revoked", com.nekko.protocol.DenyReason.REVOKED)
        runCurrent()
        assertTrue(later.last.channels().isEmpty())
        assertNull(store.map[SignOutOutbox.KEY])
    }

    @Test fun `an unreachable computer keeps the sign-out for later, then gives up after a month`() = runTest {
        val store = FakeStore()
        SignOutOutbox(store).add(PendingSignOut("wss://r", room, key, "00", "dev", clock))
        repo(store, FakeRemotes()).load()
        runCurrent()
        testScheduler.advanceTimeBy(25_000)
        runCurrent()
        assertEquals(1, SignOutOutbox(store).list().size)
        clock += SignOutOutbox.MAX_AGE_MS
        val none = FakeRemotes()
        repo(store, none).load()
        runCurrent()
        assertTrue("too old: not even dialed", none.created.isEmpty())
        assertNull(store.map[SignOutOutbox.KEY])
    }

    @Test fun `pairing the same computer again cancels its queued sign-out`() = runTest {
        val store = FakeStore()
        val repo = repo(store, FakeRemotes())
        repo.pair(link)
        runCurrent()
        repo.signOutThisPhone()
        assertNotNull(store.map[SignOutOutbox.KEY])
        repo.pair(link)
        runCurrent()
        assertNull("the new pairing must never be signed out by the old request", store.map[SignOutOutbox.KEY])
    }

    @Test fun `stopping remote access counts a dropped connection after sending as done`() = runTest {
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.REMOTE_STOP) throw RelayException("connection lost", afterSend = true)
            FakeRemotes.defaultAnswer(c)
        }
        val repo = repo(FakeStore(), remotes)
        repo.pair(link)
        runCurrent()
        remotes.last.goOnline()
        runCurrent()
        repo.stopRemoteAccess()
        assertEquals(clock, repo.state.value.remoteStoppedAt)
        // Reconnecting clears it.
        repo.connect(repo.state.value.activeId!!)
        assertNull(repo.state.value.remoteStoppedAt)
    }

    @Test fun `an exit that never left the phone is an error, not a success`() = runTest {
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.REMOTE_STOP || c.channel == Channels.APP_QUIT) throw RelayException("Could not reach your computer.")
            FakeRemotes.defaultAnswer(c)
        }
        val repo = repo(FakeStore(), remotes)
        repo.pair(link)
        runCurrent()
        try {
            repo.stopRemoteAccess()
            fail("stopped without reaching the computer")
        } catch (e: RelayException) {
            assertEquals("Could not reach your computer.", e.message)
        }
        assertNull(repo.state.value.remoteStoppedAt)
        try {
            repo.quitComputer()
            fail("quit without reaching the computer")
        } catch (_: RelayException) {
        }
    }

    @Test fun `quit is offered only when the computer says so, and its refusal reads plainly`() = runTest {
        var quitFromPhone = true
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.APP_INFO -> buildJsonObject { put("platform", "darwin"); put("quitFromPhone", quitFromPhone) }
                Channels.APP_QUIT -> throw RelayException("Not allowed from a paired phone (quit-disabled): app:quit", PhoneRefusal.parse("Not allowed from a paired phone (quit-disabled): app:quit"))
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(FakeStore(), remotes)
        repo.pair(link)
        runCurrent()
        assertFalse("unknown until the computer says", repo.state.value.quitFromPhone)
        remotes.last.goOnline()
        runCurrent()
        assertTrue(repo.state.value.quitFromPhone)
        try {
            repo.quitComputer()
            fail("a refusal is not a quit")
        } catch (e: RelayException) {
            assertEquals("Quitting from a phone is turned off on the computer (Settings → Remote access).", e.message)
        }
        quitFromPhone = false
        repo.refresh()
        assertFalse(repo.state.value.quitFromPhone)
    }

    @Test fun `a mode raise goes again with the step-up beside it`() = runTest {
        val remotes = FakeRemotes { c ->
            when (c.channel) {
                Channels.SECURITY_CHALLENGE -> Json.parseToJsonElement("""{"challenge":"BwcHBwcHBwcHBwcHBwcHBwcH","expiresAt":2000,"required":true,"methods":["security-key","totp"]}""")
                Channels.SETTINGS_UPDATE -> buildJsonObject { put("defaultChatMode", "yolo") }
                com.nekko.protocol.ChangeProof.KEY_CHANNEL -> buildJsonObject { put("registered", true) }
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = repo(FakeStore(), remotes)
        repo.pair(link)
        runCurrent()
        val ch = repo.stepUpChallenge()
        assertEquals(setOf(StepUpMethod.SECURITY_KEY, StepUpMethod.TOTP), ch.methods)
        val patch = buildJsonObject { put("defaultChatMode", "yolo") }
        repo.updatePcSettings(patch, StepUpProof.Totp("123456"))
        val call = remotes.last.calls.last()
        assertEquals(Channels.SETTINGS_UPDATE, call.channel)
        assertEquals(StepUpProof.Totp("123456"), call.stepUp)
        assertTrue("signed: the computer checks the proof before the step-up", call.proof != null)
        assertEquals(listOf(patch), call.args)
        assertEquals(com.nekko.protocol.PcSettings.ChatMode.YOLO, repo.state.value.pcSettings.defaultChatMode)
        repo.updatePcSettings(patch)
        assertNull("no step-up unless the sheet gave one", remotes.last.calls.last().stepUp)
    }

    @Test fun `a computer from before step-up says so instead of a blank sheet`() = runTest {
        val remotes = FakeRemotes { c -> if (c.channel == Channels.SECURITY_CHALLENGE) JsonPrimitive("??") else FakeRemotes.defaultAnswer(c) }
        val repo = repo(FakeStore(), remotes)
        repo.pair(link)
        runCurrent()
        try {
            repo.stepUpChallenge()
            fail("no challenge in the answer")
        } catch (e: RelayException) {
            assertTrue(e.message!!.contains("Update Nekko Agent"))
        }
    }

    @Test fun `the outbox never prints a secret and reads back what it wrote`() {
        val p = PendingSignOut("wss://r", room, key, "aa", "dev", 5)
        assertFalse(p.toString().contains(key))
        assertEquals(listOf(p), SignOutOutbox.decode(SignOutOutbox.encode(listOf(p))))
        assertTrue(SignOutOutbox.decode("not json").isEmpty())
        assertTrue(SignOutOutbox.decode("""[{"room":"x"}]""").isEmpty())
    }
}
