package com.nekko.android

import com.nekko.android.data.SecureStore
import com.nekko.android.phone.PhoneChats
import com.nekko.android.phone.PhoneHTTP
import com.nekko.protocol.PhoneRequest
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PhoneChatsTest {
    private class Memory : SecureStore {
        val values = mutableMapOf<String, String>()
        override suspend fun get(key: String) = values[key]
        override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }
    private class HTTP : PhoneHTTP {
        var hold = false
        var fail = false
        val requests = mutableListOf<PhoneRequest>()
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String {
            requests += request
            if (fail) error("secret should never be shown")
            if (line == null) return """{"data":[{"id":"chat-model","name":"Chat model"}]}"""
            line("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}"); line("")
            if (hold) awaitCancellation()
            line("data: [DONE]"); line("")
            return ""
        }
    }
    @Test fun addModelsSendPersistRetryForgetAndRemove() = runTest {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load()
        val p = phone.add("openai", "My API", null, "device-secret")
        assertTrue(memory.values["phone.providers.v1"]!!.contains("My API"))
        assertFalse(memory.values["phone.providers.v1"]!!.contains("device-secret"))
        assertEquals("Connection works.", phone.test(p))
        val id = phone.newChat(p, "chat-model")
        phone.send(id, "Hi"); runCurrent()
        assertEquals(listOf("Hi", "Hello"), phone.state.value.chats.single().messages.map { it.text })
        assertTrue(phone.state.value.running.isEmpty())
        phone.send(id, "", retry = true); runCurrent()
        assertEquals(2, phone.state.value.chats.single().messages.size)
        val loaded = PhoneChats(memory, http, backgroundScope); loaded.load()
        assertEquals(phone.state.value.chats, loaded.state.value.chats)
        phone.remove(p)
        assertFalse(memory.values.containsKey("phone.provider.key.$p"))
        assertEquals(1, phone.state.value.chats.size)
        phone.forget(id)
        val empty = PhoneChats(memory, http, backgroundScope); empty.load()
        assertTrue(empty.state.value.chats.isEmpty())
    }
    @Test fun stopDisableAndRestoreInterruptedReply() = runTest {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "old-key"); phone.models(p)
        val id = phone.newChat(p, "chat-model"); http.hold = true
        phone.send(id, "Hi"); runCurrent()
        assertEquals(setOf(id), phone.state.value.running)
        val restored = PhoneChats(memory, http, backgroundScope); restored.load()
        assertEquals("Stopped when the app closed.", restored.state.value.chats.single().messages.last().error)
        phone.enabled(p, false); runCurrent()
        assertTrue(phone.state.value.running.isEmpty())
        assertEquals("Stopped.", phone.state.value.chats.single().messages.last().error)
        phone.enabled(p, true); phone.setKey(p, "new-key"); http.hold = false
        phone.send(id, "", retry = true); runCurrent()
        assertEquals("Bearer new-key", http.requests.last().headers["Authorization"])
        assertNull(phone.state.value.chats.single().messages.last().error)
    }
    @Test fun duplicateSendIsIgnoredBeforeJobStarts() = runTest {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "key"); phone.models(p)
        val id = phone.newChat(p, "chat-model")
        phone.send(id, "First"); phone.send(id, "Duplicate"); runCurrent()
        assertEquals(listOf("First", "Hello"), phone.state.value.chats.single().messages.map { it.text })
    }
    @Test fun keyRotationIgnoresInFlightOldModels() = runTest {
        val memory = Memory(); val answer = CompletableDeferred<String>(); val started = CompletableDeferred<Unit>()
        val http = object : PhoneHTTP {
            override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String { started.complete(Unit); return answer.await() }
        }
        val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "old-key")
        val loading = backgroundScope.launch { phone.models(p) }
        runCurrent(); assertTrue(started.isCompleted)
        phone.setKey(p, "new-key")
        answer.complete("{\"data\":[{\"id\":\"stale-model\"}]}"); runCurrent()
        assertNull(phone.state.value.models[p]); loading.join()
    }
    @Test fun modelsFailureDoesNotReuseOldListOrExposeSecret() = runTest {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "secret")
        assertEquals(1, phone.models(p).size)
        http.fail = true
        assertTrue(phone.models(p).isEmpty())
        assertNull(phone.state.value.models[p])
        assertFalse(phone.state.value.errors[p]!!.contains("secret"))
    }
}
