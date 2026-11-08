package com.nekko.android

import com.nekko.android.security.ChangeCalls
import com.nekko.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceChangeCallsTest {
    private val config = RelayConfig("wss://relay.example.dev", "room", "key", ByteArray(32), TEST_HOST_KEY, "phone", "Test")
    @Test fun `authorization lost during proof prevents even key registration`() = runTest {
        val remote = FakeRemote(config) { JsonNull }
        val software = SoftwareChangeSigner.generate()
        var allowed = true
        val signer = object : ChangeSigner {
            override suspend fun publicKey() = software.publicKey()
            override suspend fun sign(message: ByteArray): ByteArray { allowed = false; return software.sign(message) }
        }
        val calls = ChangeCalls(remote, signer, "phone", "Computer")
        assertTrue(runCatching { calls.call("git:prAction", emptyList(), authorize = { check(allowed) }, retryKeyMissing = false) }.isFailure)
        assertTrue(remote.calls.isEmpty())
    }
    @Test fun `voice refusal never invokes automatic key missing retry`() = runTest {
        val remote = FakeRemote(config) { call ->
            if (call.channel == ChangeProof.KEY_CHANNEL) JsonNull else throw RelayException("Not allowed from a paired phone (key-missing): git:prAction")
        }
        val calls = ChangeCalls(remote, SoftwareChangeSigner.generate(), "phone", "Computer")
        assertTrue(runCatching { calls.call("git:prAction", emptyList(), authorize = {}, retryKeyMissing = false) }.isFailure)
        assertEquals(listOf(ChangeProof.KEY_CHANNEL, "git:prAction"), remote.channels())
    }
    @Test fun `repository rejects connection replacement after signing`() = runTest {
        val software = SoftwareChangeSigner.generate()
        lateinit var repo: com.nekko.android.data.ComputersRepository
        val signer = object : ChangeSigner {
            override suspend fun publicKey() = software.publicKey()
            override suspend fun sign(message: ByteArray): ByteArray {
                repo.disconnect()
                return software.sign(message)
            }
        }
        val remotes = FakeRemotes()
        repo = com.nekko.android.data.ComputersRepository(FakeStore(), remotes, backgroundScope, { "Test" }, changeSigner = signer, deriveKey = { _, _ -> ByteArray(32) })
        repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123", hostKey = TEST_HOST_KEY))
        runCurrent(); remotes.last.sayWelcome(); runCurrent()
        val remote = remotes.last
        assertTrue(runCatching { repo.callChange("git:prAction", emptyList(), authorize = {}, retryKeyMissing = false) }.isFailure)
        assertFalse(remote.calls.any { it.channel == ChangeProof.KEY_CHANNEL || it.channel == "git:prAction" })
    }
    @Test fun `cancellation during noncooperative signing cannot mutate after unlock`() = runTest {
        val software = SoftwareChangeSigner.generate()
        val signed = CompletableDeferred<Unit>()
        val resume = CompletableDeferred<Unit>()
        val remote = FakeRemote(config) { JsonNull }
        val signer = object : ChangeSigner {
            override suspend fun publicKey() = software.publicKey()
            override suspend fun sign(message: ByteArray): ByteArray = withContext(NonCancellable) {
                signed.complete(Unit); resume.await(); software.sign(message)
            }
        }
        val calls = ChangeCalls(remote, signer, "phone", "Computer")
        val job = launch { calls.call("git:prAction", emptyList(), authorize = { }, retryKeyMissing = false) }
        signed.await(); job.cancel(); resume.complete(Unit); job.join()
        assertTrue(remote.calls.isEmpty())
    }
}
