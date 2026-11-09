package com.nekko.android

import com.nekko.android.data.ComputersRepository
import com.nekko.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ImageChatRepositoryTest {
    private val link = PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123", hostKey = TEST_HOST_KEY)

    @Test fun `capability image model list and create use exact host API without provider or cloud`() = runTest {
        var capability = true
        val remotes = FakeRemotes { c -> when (c.channel) {
            Channels.APP_INFO -> buildJsonObject { put("capabilities", buildJsonObject { put("imageGeneration", capability) }) }
            Channels.ENGINE_MODELS -> WireJson.parseToJsonElement("""[{"id":"flux","kind":"image","name":"Flux","path":"/private"},{"id":"chat","kind":"chat"}]""")
            Channels.SESSION_CREATE -> buildJsonObject { put("id", "new-image") }
            else -> FakeRemotes.defaultAnswer(c)
        } }
        val repo = ComputersRepository(store = FakeStore(), remotes = remotes, scope = backgroundScope, deviceName = { "Test" }, deriveKey = { _, _ -> ByteArray(32) })
        repo.pair(link); runCurrent(); remotes.last.sayWelcome(); runCurrent()
        assertTrue(repo.state.value.imageGeneration)
        assertEquals(listOf("flux"), repo.imageModels().map { it.id })
        val params = ImageChatParams("flux")
        assertEquals("new-image", repo.createImageChat(params))
        val calls = remotes.last.calls
        val create = calls.single { it.channel == Channels.SESSION_CREATE }
        assertTrue(create.args.isEmpty())
        assertEquals(listOf(JsonPrimitive("new-image"), params.sessionOptions()), calls.single { it.channel == Channels.SESSION_SET_OPTIONS }.args)
        assertTrue(calls.single { it.channel == Channels.ENGINE_MODELS }.args.isEmpty())
        assertFalse(calls.any { it.channel.contains("install", true) || it.channel.contains("remove", true) || it.channel.startsWith("cloud:") })
        val count = calls.size
        assertTrue(runCatching { repo.createImageChat(params.copy(cfgScale = 4.5)) }.isFailure)
        assertEquals(count, calls.size)
        capability = false; repo.refresh()
        assertFalse(repo.state.value.imageGeneration)
        assertTrue(runCatching { repo.createImageChat(params) }.isFailure)
        remotes.last.status.value = RelayStatus(RelayState.OFFLINE); runCurrent()
        assertTrue(runCatching { repo.createImageChat(params) }.isFailure)
        assertTrue(repo.outbox.state.value.items.isEmpty())
    }

    @Test fun `generation is signed with the existing key registration and exact integer payload`() = runTest {
        val signer = SoftwareChangeSigner.generate()
        val requests = mutableListOf<Call>()
        val remotes = FakeRemotes { c ->
            requests += c
            when (c.channel) {
                Channels.CHAT_GENERATE_IMAGE -> JsonNull
                else -> FakeRemotes.defaultAnswer(c)
            }
        }
        val repo = ComputersRepository(store = FakeStore(), remotes = remotes, scope = backgroundScope, changeSigner = signer, deviceName = { "Test" }, deriveKey = { _, _ -> ByteArray(32) })
        repo.pair(link); runCurrent(); remotes.last.sayWelcome(); runCurrent()
        val args = listOf(ImageChatParams("flux").generation("s", "cat"))
        repo.callChange(Channels.CHAT_GENERATE_IMAGE, args, timeoutMs = 123_456)
        assertEquals(1, requests.count { it.channel == ChangeProof.KEY_CHANNEL })
        val generated = requests.single { it.channel == Channels.CHAT_GENERATE_IMAGE }
        assertNotNull(generated.proof)
        assertEquals(args, generated.args)
        assertEquals(123_456L, generated.timeoutMs)
        val proof = generated.proof!!
        val payload = ChangeProof.payload(remotes.last.config.deviceId, Channels.CHAT_GENERATE_IMAGE, JsonArray(args), proof["ts"]!!.jsonPrimitive.long)
        assertTrue(ChangeProof.verify(signer.publicKey(), payload, java.util.Base64.getDecoder().decode(proof["sig"]!!.jsonPrimitive.content)))
    }
}
