package com.nekko.android

import com.nekko.android.data.SecureStore
import com.nekko.android.phone.PhoneChats
import com.nekko.android.phone.PhoneHTTP
import com.nekko.protocol.PhoneProviders
import com.nekko.protocol.PhoneRequest
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PhoneChatsTest {
    private class Memory : SecureStore {
        val values = mutableMapOf<String, String>()
        var failChats = false
        override suspend fun get(key: String) = values[key]
        override suspend fun set(key: String, value: String?) {
            if (failChats && key == "phone.chats.v1") error("storage unavailable")
            if (value == null) values.remove(key) else values[key] = value
        }
    }
    private class HTTP : PhoneHTTP {
        var hold = false
        var fail = false
        var done = true
        val requests = mutableListOf<PhoneRequest>()
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String {
            requests += request
            if (fail) error("secret should never be shown")
            if (line == null) return """{"data":[{"id":"chat-model","name":"Chat model"}]}"""
            line("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}"); line("")
            if (hold) awaitCancellation()
            if (done) { line("data: [DONE]"); line("") }
            return ""
        }
    }
    private class Pending(val callback: ((String) -> Boolean)?) {
        val result = CompletableDeferred<String>()
        var cancelled = false
        fun text(text: String) {
            callback!!("data: {\"choices\":[{\"delta\":{\"content\":\"$text\"}}]}")
            callback.invoke("")
        }
        fun done() { callback!!("data: [DONE]"); callback.invoke("") }
    }
    private class ControlledHTTP : PhoneHTTP {
        val calls = mutableListOf<Pending>()
        var ignoreCancellation = false
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String {
            val call = Pending(line); calls += call
            return try {
                if (ignoreCancellation) withContext(NonCancellable) { call.result.await() } else call.result.await()
            } finally { call.cancelled = !currentCoroutineContext().isActive }
        }
    }
    private val modelJSON = """{"data":[{"id":"chat-model","name":"Chat model"}]}"""

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
    // #2950: the limit line reads the key's budget from the last answer's headers, kept in memory only.
    private class Limited : PhoneHTTP {
        var headers = mapOf("x-ratelimit-limit-tokens" to "30000", "x-ratelimit-remaining-tokens" to "26400", "x-ratelimit-reset-tokens" to "20s")
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String = send(request, line) {}
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?, headers: (Map<String, String>) -> Unit): String {
            if (line == null) return """{"data":[{"id":"chat-model","name":"Chat model"}]}"""
            headers(this.headers)
            line("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}"); line("")
            line("data: [DONE]"); line("")
            return ""
        }
    }

    @Test fun answersKeepTheKeysBudgetInMemoryUntilANewKey() = runTest {
        val memory = Memory(); val phone = PhoneChats(memory, Limited(), backgroundScope)
        phone.load()
        val p = phone.add("openai", "My API", null, "device-secret")
        assertNull(phone.state.value.rateLimits[p])
        phone.models(p)
        val id = phone.newChat(p, "chat-model")
        phone.send(id, "Hi"); runCurrent()
        val limits = phone.state.value.rateLimits[p]
        assertEquals(30_000L, limits?.tokensLimit)
        assertEquals(26_400L, limits?.tokensRemaining)
        assertFalse("never saved", memory.values.values.any { it.contains("26400") })
        phone.setKey(p, "new-secret")
        assertNull(phone.state.value.rateLimits[p])
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
        val memory = Memory(); val http = ControlledHTTP(); http.ignoreCancellation = true
        val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "old-key")
        val loading = backgroundScope.launch { phone.models(p) }
        runCurrent(); assertEquals(1, http.calls.size)
        phone.setKey(p, "new-key")
        http.calls.single().result.complete(modelJSON); runCurrent()
        assertNull(phone.state.value.models[p]); assertNull(phone.state.value.errors[p])
        assertTrue(loading.isCancelled)
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
    @Test fun everyProviderMutationCancelsModelsAndTestRequests() = runTest {
        for (change in listOf("disable", "remove", "rotate")) {
            for (kind in listOf("openai", "bedrock")) {
                val http = ControlledHTTP(); val phone = PhoneChats(Memory(), http, backgroundScope)
                phone.load(); val p = phone.add(kind, "API", null, "key")
                val testing = backgroundScope.launch { phone.test(p) }
                runCurrent(); assertEquals(1, http.calls.size)
                when (change) {
                    "disable" -> phone.enabled(p, false)
                    "remove" -> phone.remove(p)
                    else -> phone.setKey(p, "replacement")
                }
                runCurrent()
                assertTrue("$change $kind", testing.isCancelled)
                assertTrue(http.calls.single().cancelled)
                assertNull(phone.state.value.models[p]); assertNull(phone.state.value.errors[p])
            }
        }
    }
    @Test fun staleSuccessAndFailureCannotOverwriteNewModelLoad() = runTest {
        for (failure in listOf(false, true)) {
            val http = ControlledHTTP(); val phone = PhoneChats(Memory(), http, backgroundScope)
            phone.load(); val p = phone.add("openai", "API", null, "key")
            var stale = listOf<com.nekko.protocol.PhoneModel>()
            val first = backgroundScope.launch { stale = phone.models(p) }; runCurrent()
            val second = backgroundScope.launch { phone.models(p) }; runCurrent()
            http.calls[1].result.complete(modelJSON); runCurrent()
            if (failure) http.calls[0].result.completeExceptionally(IllegalStateException("secret"))
            else http.calls[0].result.complete("""{"data":[{"id":"old"}]}""")
            runCurrent(); first.join(); second.join()
            assertTrue(stale.isEmpty())
            assertEquals("chat-model", phone.state.value.models[p]!!.single().id)
            assertNull(phone.state.value.errors[p])
        }
    }
    @Test fun lateFailureAfterRemoveDoesNotRestoreProviderError() = runTest {
        val http = ControlledHTTP(); http.ignoreCancellation = true
        val phone = PhoneChats(Memory(), http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "key")
        val loading = backgroundScope.launch { phone.models(p) }; runCurrent()
        phone.remove(p)
        http.calls.single().result.completeExceptionally(IllegalStateException("secret")); runCurrent()
        assertTrue(loading.isCancelled)
        assertTrue(phone.state.value.providers.isEmpty())
        assertTrue(phone.state.value.models.isEmpty()); assertTrue(phone.state.value.errors.isEmpty())
    }
    @Test fun queuedSendCancelledByLifecycleNeverSendsOrChangesTranscript() = runTest {
        for (change in listOf("stop", "disable", "remove", "rotate", "forget")) {
            val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
            phone.load(); val p = phone.add("openai", "API", null, "key"); phone.models(p)
            val id = phone.newChat(p, "chat-model")
            phone.send(id, "must not send")
            when (change) {
                "stop" -> phone.stop(id)
                "disable" -> phone.enabled(p, false)
                "remove" -> phone.remove(p)
                "rotate" -> phone.setKey(p, "replacement")
                else -> phone.forget(id)
            }
            runCurrent()
            assertEquals(change, 1, http.requests.size)
            assertTrue(phone.state.value.running.isEmpty())
            assertTrue(phone.state.value.chats.all { it.messages.isEmpty() })
        }
    }
    @Test fun forgetDuringStreamCannotResurrectTranscriptOrErrors() = runTest {
        val memory = Memory(); val http = ControlledHTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("bedrock", "API", null, "key"); val models = phone.models(p)
        val id = phone.newChat(p, models.first().id)
        phone.send(id, "Hi"); runCurrent()
        phone.forget(id); runCurrent()
        assertTrue(http.calls.single().cancelled)
        assertTrue(runCatching { http.calls.single().text("late") }.exceptionOrNull() is CancellationException)
        val restored = PhoneChats(memory, HTTP(), backgroundScope); restored.load()
        assertTrue(restored.state.value.chats.isEmpty()); assertTrue(phone.state.value.errors.isEmpty())
        assertTrue(phone.state.value.running.isEmpty())
    }
    @Test fun lateCallbackFromStoppedAttemptCannotRewriteRetry() = runTest {
        val http = ControlledHTTP(); val phone = PhoneChats(Memory(), http, backgroundScope)
        phone.load(); val p = phone.add("bedrock", "API", null, "key"); val models = phone.models(p)
        val id = phone.newChat(p, models.first().id)
        phone.send(id, "Hi"); runCurrent(); val old = http.calls.single()
        phone.stop(id); runCurrent()
        phone.send(id, "", retry = true); runCurrent()
        assertTrue(runCatching { old.text("old") }.exceptionOrNull() is CancellationException)
        // The callback uses OpenAI SSE here; parser accepts it independent of provider kind.
        http.calls.last().text("new"); http.calls.last().done(); http.calls.last().result.complete(""); runCurrent()
        assertEquals(listOf("Hi", "new"), phone.state.value.chats.single().messages.map { it.text })
        assertNull(phone.state.value.chats.single().messages.last().error)
    }
    @Test fun incompleteStreamKeepsPartialTextAndRetryReplacesOnlyLastAttempt() = runTest {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "key"); phone.models(p)
        val id = phone.newChat(p, "chat-model"); http.done = false
        phone.send(id, "Hi"); runCurrent()
        val partial = phone.state.value.chats.single().messages.last()
        assertEquals("Hello", partial.text); assertNotNull(partial.error)
        assertFalse(partial.error!!.contains("secret"))
        http.done = true; phone.send(id, "", retry = true); runCurrent()
        val messages = phone.state.value.chats.single().messages
        assertEquals(2, messages.size); assertNotEquals(partial.id, messages.last().id)
        assertNull(messages.last().error)
        val restored = PhoneChats(memory, http, backgroundScope); restored.load()
        assertEquals(messages, restored.state.value.chats.single().messages)
    }
    @Test fun testRequiresCompletionAndSanitizesTransportFailure() = runTest {
        val http = HTTP(); val phone = PhoneChats(Memory(), http, backgroundScope)
        phone.load(); val p = phone.add("bedrock", "API", null, "key")
        http.done = false
        assertTrue(runCatching { phone.test(p) }.exceptionOrNull() is IllegalStateException)
        http.fail = true
        val failure = runCatching { phone.test(p) }.exceptionOrNull()
        assertNotNull(failure); assertFalse(failure!!.message!!.contains("secret"))
    }
    @Test fun storageFailureClearsRunningAndAllowsRetry() = runTest {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load(); val p = phone.add("openai", "API", null, "key"); phone.models(p)
        val id = phone.newChat(p, "chat-model"); memory.failChats = true
        phone.send(id, "Hi"); runCurrent()
        assertTrue(phone.state.value.running.isEmpty())
        assertNotNull(phone.state.value.chats.single().messages.last().error)
        assertNotNull(phone.state.value.errors[id])
        memory.failChats = false; phone.send(id, "", retry = true); runCurrent()
        assertNull(phone.state.value.chats.single().messages.last().error)
        assertNull(phone.state.value.errors[id])
    }
    @Test fun mutationsBeforeLoadCannotOverwriteSavedData() = runTest {
        val memory = Memory(); val http = HTTP(); val original = PhoneChats(memory, http, backgroundScope)
        original.load(); val p = original.add("openai", "API", null, "key"); original.models(p)
        val id = original.newChat(p, "chat-model")
        val before = memory.values.toMap()
        val unloaded = PhoneChats(memory, http, backgroundScope)
        assertTrue(runCatching { unloaded.add("openai", "Other", null, "other") }.isFailure)
        assertTrue(runCatching { unloaded.remove(p) }.isFailure)
        assertTrue(runCatching { unloaded.forget(id) }.isFailure)
        unloaded.send(id, "Hi"); runCurrent()
        assertEquals(before, memory.values)
        unloaded.load(); assertEquals(original.state.value.chats, unloaded.state.value.chats)
    }
    @Test fun providerChangesPersistStoppedAttemptBeforeCleanupRuns() = runTest {
        for (change in listOf("disable", "remove", "rotate")) {
            val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
            phone.load(); val p = phone.add("openai", "API", null, "key"); phone.models(p)
            val id = phone.newChat(p, "chat-model"); http.hold = true
            phone.send(id, "Hi"); runCurrent()
            when (change) {
                "disable" -> phone.enabled(p, false)
                "remove" -> phone.remove(p)
                else -> phone.setKey(p, "replacement")
            }
            val restored = PhoneChats(memory, HTTP(), backgroundScope); restored.load()
            assertEquals("Stopped.", restored.state.value.chats.single().messages.last().error)
            assertEquals("Hello", restored.state.value.chats.single().messages.last().text)
            runCurrent(); assertTrue(phone.state.value.running.isEmpty())
        }
    }
    @Test fun ownerScopeCancellationPersistsStoppedAttempt() = runTest {
        val memory = Memory(); val http = HTTP()
        val owner = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val phone = PhoneChats(memory, http, owner)
        phone.load(); val p = phone.add("openai", "API", null, "key"); phone.models(p)
        val id = phone.newChat(p, "chat-model"); http.hold = true
        phone.send(id, "Hi"); runCurrent(); owner.cancel(); runCurrent()
        assertTrue(phone.state.value.running.isEmpty())
        val restored = PhoneChats(memory, HTTP(), backgroundScope); restored.load()
        assertEquals("Stopped.", restored.state.value.chats.single().messages.last().error)
        val before = restored.state.value.chats
        phone.send(id, "never sent"); runCurrent()
        assertEquals(before, phone.state.value.chats)
    }
    @Test fun transcriptWriteFailureCannotPreventCredentialRemovalOrRotation() = runTest {
        for (remove in listOf(false, true)) {
            val memory = Memory(); val phone = PhoneChats(memory, HTTP(), backgroundScope)
            phone.load(); val p = phone.add("openai", "API", null, "old-key")
            memory.failChats = true
            assertTrue(runCatching {
                if (remove) phone.remove(p) else phone.setKey(p, "replacement")
            }.isFailure)
            assertEquals(if (remove) null else "replacement", memory.values["phone.provider.key.$p"])
            assertTrue(phone.state.value.models.isEmpty())
        }
    }
    @Test fun ownerScopeCancellationAlsoCancelsModelsAndTests() = runTest {
        for (kind in listOf("openai", "bedrock")) {
            val http = ControlledHTTP()
            val owner = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
            val phone = PhoneChats(Memory(), http, owner)
            phone.load(); val p = phone.add(kind, "API", null, "key")
            val testing = backgroundScope.launch { phone.test(p) }; runCurrent()
            assertEquals(1, http.calls.size)
            owner.cancel(); runCurrent()
            assertTrue(testing.isCancelled); assertTrue(http.calls.single().cancelled)
            assertNull(phone.state.value.errors[p])
        }
    }

    /** #2426: Customize → Tone reaches the next phone-hosted reply's system prompt and survives a relaunch. */
    @Test fun theToneGoesWithTheNextReplyAndIsKept() = runTest {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load()
        val p = phone.add("openai", "My API", null, "device-secret")
        phone.models(p)
        val id = phone.newChat(p, "chat-model")
        phone.send(id, "Hi"); runCurrent()
        val plain = http.requests.last().body.toString()
        assertTrue(plain.contains("You are Nekko Agent"))
        assertFalse(plain.contains("Communication preference"))

        phone.setTone(com.nekko.protocol.PhoneTone.CONCISE)
        phone.send(id, "Again"); runCurrent()
        val toned = http.requests.last().body.toString()
        assertTrue(toned.contains("Communication preference: Keep replies brief"))
        assertEquals("the saved messages are not rewritten", listOf("Hi", "Hello", "Again", "Hello"), phone.state.value.chats.single().messages.map { it.text })

        val again = PhoneChats(memory, http, backgroundScope); again.load()
        assertEquals(com.nekko.protocol.PhoneTone.CONCISE, again.state.value.tone)
        assertEquals("an unknown saved tone reads as Default", com.nekko.protocol.PhoneTone.STANDARD, com.nekko.protocol.PhoneTone.parse("Pirate"))
    }

    // #2852: a provider is kept only once its key works; OpenRouter's sign-in adds one by itself.
    private class Routed(val answer: (PhoneRequest) -> String) : PhoneHTTP {
        val requests = mutableListOf<PhoneRequest>()
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String { requests += request; return answer(request) }
    }

    @Test fun connectKeepsAWorkingKeyAndTurnsDownAWrongOne() = runTest {
        var refuse = true
        val http = Routed { r -> if (r.url.endsWith("/key") && refuse) throw java.io.IOException(PhoneProviders.failure(401)) else modelJSON }
        val memory = Memory(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load()
        val wrong = runCatching { phone.connect("openrouter", "OpenRouter", null, "bad") }.exceptionOrNull()
        assertEquals(PhoneProviders.failure(401), wrong?.message)
        assertTrue(phone.state.value.providers.isEmpty())
        assertFalse(memory.values.values.contains("bad"))
        refuse = false
        val id = phone.connect("openrouter", "OpenRouter", null, "good")
        assertEquals(listOf("chat-model"), phone.state.value.models[id]!!.map { it.id })
        assertTrue(memory.values.values.contains("good"))
    }

    @Test fun ollamasUnknownModelMeansTheKeyPassed() = runTest {
        val http = Routed { r -> if (r.url.endsWith("/chat/completions")) throw java.io.IOException(PhoneProviders.failure(404)) else modelJSON }
        val phone = PhoneChats(Memory(), http, backgroundScope)
        phone.load()
        phone.connect("ollama-cloud", "Ollama Cloud", null, "key")
        assertEquals(1, phone.state.value.providers.size)
    }

    @Test fun openRouterSignInSwapsTheCodeAndKeepsTheProvider() = runTest {
        val http = Routed { r -> if (r.url.endsWith("/auth/keys")) """{"key":"sk-or-signed"}""" else modelJSON }
        val memory = Memory(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load()
        // A callback with no sign-in under way is ignored.
        phone.finishOpenRouterSignIn("nekko-agent://openrouter-key?code=stray")
        assertTrue(http.requests.isEmpty())
        val page = phone.startOpenRouterSignIn()
        assertTrue(page.startsWith("https://openrouter.ai/auth?"))
        assertEquals(PhoneChats.SignIn.WAITING, phone.state.value.signIn)
        phone.finishOpenRouterSignIn("nekko-agent://openrouter-key?code=abc")
        assertEquals(PhoneChats.SignIn.DONE, phone.state.value.signIn)
        val swap = http.requests.first()
        assertEquals("abc", swap.body!!["code"].toString().trim('"'))
        // The verifier sent is the one the challenge was made from.
        val challenge = page.substringAfter("code_challenge=").substringBefore('&')
        assertEquals(challenge, PhoneProviders.pkceChallenge(swap.body!!["code_verifier"].toString().trim('"')))
        assertEquals("OpenRouter", phone.state.value.providers.single().label)
        assertTrue(memory.values.values.contains("sk-or-signed"))
    }

    @Test fun aFailedSignInSaysSoAndKeepsNothing() = runTest {
        val http = Routed { r -> if (r.url.endsWith("/auth/keys")) "{}" else modelJSON }
        val phone = PhoneChats(Memory(), http, backgroundScope)
        phone.load()
        phone.startOpenRouterSignIn()
        phone.finishOpenRouterSignIn("nekko-agent://openrouter-key?code=abc")
        assertEquals(PhoneProviders.SIGN_IN_FAILED, phone.state.value.signInError)
        assertNull(phone.state.value.signIn)
        assertTrue(phone.state.value.providers.isEmpty())
    }

    // ChatGPT on the phone (#3244): the sign-in's tokens are the key, renewed before they run out.
    private val chatGptModels = """{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5"}]}"""
    private fun chatGptTokens(expiresAt: Long, access: String = "access-1") =
        com.nekko.protocol.ChatGptSignIn.Tokens(access, "refresh-1", expiresAt, "acct-1")

    @Test fun aChatGptSignInIsKeptAndItsModelsAreThePlans() = runTest {
        val http = Routed { r -> if (r.url.contains("/codex/models")) chatGptModels else error("unexpected ${r.url}") }
        val memory = Memory(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load()
        val id = phone.connect("chatgpt", "ChatGPT", null, chatGptTokens(System.currentTimeMillis() + 3_600_000).encode())
        assertEquals(listOf("gpt-5.5"), phone.state.value.models[id]!!.map { it.id })
        assertEquals("acct-1", http.requests.single().headers["chatgpt-account-id"])
        // An API key is not a sign-in.
        try { phone.connect("chatgpt", "ChatGPT", null, "sk-key"); fail("kept an API key as a sign-in") } catch (_: IllegalArgumentException) {}
    }

    @Test fun aChatGptSignInAboutToRunOutIsRenewedFirst() = runTest {
        val renewed = chatGptTokens(System.currentTimeMillis() + 3_600_000, access = "access-2")
        val http = Routed { r ->
            when {
                r.url == com.nekko.protocol.ChatGptSignIn.TOKEN_URL -> """{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600}"""
                r.url.contains("/codex/models") -> chatGptModels
                else -> error("unexpected ${r.url}")
            }
        }
        val memory = Memory(); val phone = PhoneChats(memory, http, backgroundScope)
        phone.load()
        // Kept while fresh, then left until it is a minute from running out.
        val id = phone.connect("chatgpt", "ChatGPT", null, chatGptTokens(System.currentTimeMillis() + 3_600_000).encode())
        memory.values["phone.provider.key.$id"] = chatGptTokens(System.currentTimeMillis() + 60_000).encode()
        http.requests.clear()
        phone.models(id)
        val refresh = http.requests.first()
        assertEquals(com.nekko.protocol.ChatGptSignIn.TOKEN_URL, refresh.url)
        assertTrue(refresh.form!!.contains("grant_type=refresh_token") && refresh.form!!.contains("refresh_token=refresh-1"))
        assertEquals("Bearer access-2", http.requests.last().headers["Authorization"])
        val kept = com.nekko.protocol.ChatGptSignIn.Tokens.decode(memory.values["phone.provider.key.$id"])!!
        assertEquals(renewed.access, kept.access)
        assertEquals("refresh-2", kept.refresh)
        assertEquals("acct-1", kept.accountId)
    }
}
