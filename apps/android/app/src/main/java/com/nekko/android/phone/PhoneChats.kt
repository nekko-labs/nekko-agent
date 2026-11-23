package com.nekko.android.phone

import com.nekko.android.data.SecureStore
import com.nekko.protocol.*
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** All data is device-only. Keys occupy separate Keystore-sealed slots, never provider JSON. */
class PhoneChats(private val secrets: SecureStore, private val http: PhoneHTTP, private val scope: CoroutineScope) {
    data class State(
        val ready: Boolean = false,
        val providers: List<PhoneProvider> = emptyList(),
        val chats: List<PhoneChat> = emptyList(),
        val models: Map<String, List<PhoneModel>> = emptyMap(),
        val running: Set<String> = emptySet(),
        val errors: Map<String, String> = emptyMap(),
        /** What this phone's chats used, by provider, model and day (#2114); never sent anywhere. */
        val usage: com.nekko.protocol.PhoneUsageLedger = com.nekko.protocol.PhoneUsageLedger(),
        /** How this phone's models talk (Customize, #2426); from their next reply. */
        val tone: com.nekko.protocol.PhoneTone = com.nekko.protocol.PhoneTone.STANDARD,
        /** A browser sign-in while it runs: OpenRouter's (#2852) or ChatGPT's (#3244, [signInKind]). */
        val signIn: SignIn? = null,
        val signInError: String? = null,
        val signInKind: String? = null,
    )
    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    // Storage is serialized across suspensions; gate also protects HTTP-thread callbacks.
    private val lock = Mutex()
    private val gate = Any()
    private val tasks = mutableMapOf<String, Job>()
    private val operations = mutableMapOf<String, MutableSet<Job>>()
    private val modelLoads = mutableMapOf<String, Any>()
    private val providersSlot = "phone.providers.v1"
    private val chatsSlot = "phone.chats.v1"
    private val usageSlot = "phone.usage.v1"
    private val toneSlot = "phone.tone.v1"
    private fun keySlot(id: String) = "phone.provider.key.$id"
    private fun id() = UUID.randomUUID().toString()
    private fun now() = System.currentTimeMillis()
    private fun ready() = check(mutable.value.ready) { "Unlock and load phone chats first." }

    suspend fun load() = lock.withLock {
        if (mutable.value.ready) return@withLock
        val providers = secrets.get(providersSlot)?.let { json.decodeFromString(ListSerializer(PhoneProvider.serializer()), it) }.orEmpty()
        val chats = secrets.get(chatsSlot)?.let { json.decodeFromString(ListSerializer(PhoneChat.serializer()), it) }.orEmpty().map { c ->
            c.copy(messages = c.messages.map { m -> if (m.role == "assistant" && m.error == STREAMING) m.copy(error = "Stopped when the app closed.") else m })
        }
        val usage = secrets.get(usageSlot)?.let { runCatching { com.nekko.protocol.PhoneUsageLedger.from(Json.parseToJsonElement(it)) }.getOrNull() }
            ?: com.nekko.protocol.PhoneUsageLedger()
        val tone = com.nekko.protocol.PhoneTone.parse(secrets.get(toneSlot))
        synchronized(gate) { mutable.value = State(ready = true, providers = providers, chats = chats, usage = usage, tone = tone) }
    }

    /** The tone for the next reply of every chat on this phone; saved messages are never rewritten. */
    suspend fun setTone(tone: com.nekko.protocol.PhoneTone) = lock.withLock {
        synchronized(gate) { mutable.update { it.copy(tone = tone) } }
        secrets.set(toneSlot, tone.wire)
    }
    private suspend fun saveProviders() = secrets.set(providersSlot, json.encodeToString(ListSerializer(PhoneProvider.serializer()), mutable.value.providers))
    private suspend fun saveChats() = secrets.set(chatsSlot, json.encodeToString(ListSerializer(PhoneChat.serializer()), mutable.value.chats))
    private suspend fun saveUsage() = secrets.set(usageSlot, mutable.value.usage.json().toString())

    /**
     * Keep a provider only once it works (#2852, the iPhone's #2853/#2855): its models load, and
     * where that list answers anyone (OpenRouter, Ollama Cloud), a request a bad key is refused on.
     * A wrong key is turned down here, with the provider's reason; nothing is saved.
     */
    suspend fun connect(kind: String, label: String, url: String?, key: String?, workspace: String? = null): String {
        val p = PhoneProviders.make(id(), kind, label, url, key, workspace)
        val models = verifyKey(p, key)
        return keep(p, key).also { id -> synchronized(gate) { mutable.update { it.copy(models = it.models + (id to models)) } } }
    }

    /** Keep a provider as given, unchecked (tests and restores). */
    suspend fun add(kind: String, label: String, url: String?, key: String?, workspace: String? = null): String =
        keep(PhoneProviders.make(id(), kind, label, url, key, workspace), key)

    private suspend fun verifyKey(p: PhoneProvider, key: String?): List<PhoneModel> {
        val models = PhoneProviders.modelsRequest(p, key)?.let { PhoneProviders.models(http.send(it), p.kind) } ?: PhoneProviders.kind(p.kind)!!.catalog
        require(models.isNotEmpty()) { "The provider listed no models." }
        // OpenAI lists models for a key with no credit: its probe is a tiny chat with the default model.
        val probe = PhoneProviders.keyCheckRequest(p, key, PhoneProviders.defaultModel(models)?.id) ?: return models
        try {
            http.send(probe)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val m = e.message.orEmpty()
            // OpenAI's probe is a real chat, so any refusal fails it.
            if (p.kind == "openai" && e is ProviderRefusal) throw IllegalArgumentException(m)
            // Otherwise only a refusal of the key counts; an unknown model (Ollama's probe) means the key passed.
            if ("(401)" in m || "(403)" in m) throw IllegalArgumentException(m)
            if (m.startsWith("Could not reach")) throw IllegalArgumentException("Could not reach the provider to check the key. Try again.")
        }
        return models
    }

    /** OpenRouter's sign-in answers with a code; swap it for the API key it stands for. */
    suspend fun openRouterKey(code: String, verifier: String): String {
        val body = try { http.send(PhoneProviders.openRouterKeyRequest(code, verifier)) } catch (e: CancellationException) { throw e } catch (_: Exception) { throw IllegalArgumentException(PhoneProviders.SIGN_IN_FAILED) }
        return PhoneProviders.openRouterKey(body) ?: throw IllegalArgumentException(PhoneProviders.SIGN_IN_FAILED)
    }

    /** The sign-in under way: its verifier waits here until the browser comes back with a code. */
    private var signInVerifier: String? = null

    /** Start OpenRouter's sign-in: the page to open in the browser. */
    fun startOpenRouterSignIn(): String {
        val v = PhoneProviders.pkceVerifier()
        synchronized(gate) { signInVerifier = v; mutable.update { it.copy(signIn = SignIn.WAITING, signInError = null, signInKind = "openrouter") } }
        return PhoneProviders.openRouterAuthorizeUrl(PhoneProviders.pkceChallenge(v))
    }

    /** The browser came back to `nekko-agent://openrouter-key`: swap the code, check the key, keep the provider. */
    suspend fun finishOpenRouterSignIn(callback: String) {
        val verifier = synchronized(gate) { signInVerifier.also { signInVerifier = null } } ?: return
        val code = PhoneProviders.openRouterCode(callback)
        synchronized(gate) { mutable.update { it.copy(signIn = SignIn.ADDING, signInError = null) } }
        try {
            if (code == null) throw IllegalArgumentException(PhoneProviders.SIGN_IN_FAILED)
            val kind = PhoneProviders.kind("openrouter")!!
            connect(kind.id, kind.label, null, openRouterKey(code, verifier))
            synchronized(gate) { mutable.update { it.copy(signIn = SignIn.DONE) } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            synchronized(gate) { mutable.update { it.copy(signIn = null, signInError = e.message ?: PhoneProviders.SIGN_IN_FAILED) } }
        }
    }

    /** ChatGPT's sign-in listener, open while its page is (#3244). */
    private var chatGptListener: ChatGptSignIn.CallbackServer? = null

    /**
     * Start Sign in with ChatGPT (#3244): open the loopback listener the page comes back to, and
     * return the page to open in the browser; null when the listener can't open (the reason is in
     * [State.signInError]). The code is swapped for this phone's own tokens, the plan's models are
     * read (which also proves the sign-in), and the provider is kept, or its sign-in replaced.
     */
    fun startChatGptSignIn(): String? {
        val verifier = PhoneProviders.pkceVerifier()
        val state = ChatGptSignIn.state()
        val listener = try { ChatGptSignIn.CallbackServer.open() } catch (e: java.io.IOException) {
            synchronized(gate) { mutable.update { it.copy(signIn = null, signInKind = "chatgpt", signInError = e.message ?: ChatGptSignIn.PORT_BUSY) } }
            return null
        }
        synchronized(gate) {
            chatGptListener?.close()
            chatGptListener = listener
            mutable.update { it.copy(signIn = SignIn.WAITING, signInKind = "chatgpt", signInError = null) }
        }
        scope.launch(Dispatchers.IO) {
            val answer = listener.await(state)
            val current = synchronized(gate) { (chatGptListener === listener).also { if (it) chatGptListener = null } }
            if (!current) return@launch
            when (answer) {
                is ChatGptSignIn.Callback.Code -> finishChatGptSignIn(answer.code, verifier)
                is ChatGptSignIn.Callback.Refused -> synchronized(gate) { mutable.update { it.copy(signIn = null, signInError = "ChatGPT sign-in was cancelled.") } }
                // Timed out with the page left open: back to the form, nothing to say.
                else -> synchronized(gate) { mutable.update { it.copy(signIn = null) } }
            }
        }
        return ChatGptSignIn.authorizeUrl(PhoneProviders.pkceChallenge(verifier), state)
    }

    private suspend fun finishChatGptSignIn(code: String, verifier: String) {
        synchronized(gate) { mutable.update { it.copy(signIn = SignIn.ADDING, signInError = null) } }
        try {
            val body = try { http.send(ChatGptSignIn.tokenRequest(code, verifier)) } catch (e: CancellationException) { throw e } catch (_: Exception) { throw IllegalArgumentException(ChatGptSignIn.SIGN_IN_FAILED) }
            val tokens = ChatGptSignIn.tokens(body, now()) ?: throw IllegalArgumentException(ChatGptSignIn.SIGN_IN_FAILED)
            val existing = lock.withLock { mutable.value.providers.firstOrNull { it.kind == "chatgpt" } }
            if (existing == null) {
                connect("chatgpt", "ChatGPT", null, tokens.encode())
            } else {
                // Signing in again replaces the old sign-in; the provider and its chats stay.
                setKey(existing.id, tokens.encode())
                if (!existing.enabled) enabled(existing.id, true)
            }
            synchronized(gate) { mutable.update { it.copy(signIn = SignIn.DONE) } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            synchronized(gate) { mutable.update { it.copy(signIn = null, signInError = e.message ?: ChatGptSignIn.SIGN_IN_FAILED) } }
        }
    }

    private val renewing = Mutex()

    /**
     * A ChatGPT sign-in about to run out is renewed before it is used (#3244); other keys pass.
     * One renewal at a time: OpenAI replaces the refresh token each time. A failed renewal leaves
     * the old tokens, and the request then fails with "sign in again".
     */
    private suspend fun renewSignIn(providerId: String) = renewing.withLock {
        val (p, key) = lock.withLock {
            val p = mutable.value.providers.firstOrNull { it.id == providerId && it.kind == "chatgpt" } ?: return@withLock null
            p to secrets.get(keySlot(p.id))
        } ?: return@withLock
        val tokens = ChatGptSignIn.Tokens.decode(key)?.takeIf { it.needsRefresh(now()) } ?: return@withLock
        val request = ChatGptSignIn.refreshRequest(tokens) ?: return@withLock
        val body = try { http.send(request) } catch (e: CancellationException) { throw e } catch (_: Exception) { return@withLock }
        val next = ChatGptSignIn.tokens(body, now(), tokens) ?: return@withLock
        lock.withLock { if (secrets.get(keySlot(p.id)) == key) secrets.set(keySlot(p.id), next.encode()) }
    }

    /** The person left the sign-in (Cancel, or back without approving). */
    fun clearSignIn() = synchronized(gate) {
        signInVerifier = null
        chatGptListener?.close(); chatGptListener = null
        mutable.update { it.copy(signIn = null, signInError = null, signInKind = null) }
    }

    enum class SignIn { WAITING, ADDING, DONE }

    private suspend fun keep(p: PhoneProvider, key: String?): String = lock.withLock {
        ready()
        secrets.set(keySlot(p.id), key?.trim()?.ifEmpty { null })
        synchronized(gate) { mutable.update { it.copy(providers = it.providers + p) } }
        saveProviders(); p.id
    }
    suspend fun setKey(providerId: String, key: String) = lock.withLock {
        ready()
        val p = mutable.value.providers.first { it.id == providerId }
        PhoneProviders.make(p.id, p.kind, p.label, p.baseUrl, key, p.workspaceId)
        synchronized(gate) { invalidateProvider(providerId) }
        // Transcript persistence must not prevent credential replacement.
        secrets.set(keySlot(providerId), key.trim().ifEmpty { null })
        saveChats()
    }
    // Called with gate held. Cancel every request, including a tiny billable Test reply.
    private fun invalidateProvider(providerId: String) {
        operations.remove(providerId)?.toList()?.forEach { it.cancel() }
        modelLoads.remove(providerId)
        mutable.value.chats.filter { it.providerId == providerId }.forEach { stop(it.id) }
        mutable.update { it.copy(models = it.models - providerId, errors = it.errors - providerId) }
    }
    suspend fun enabled(providerId: String, on: Boolean) = lock.withLock {
        ready()
        synchronized(gate) {
            invalidateProvider(providerId)
            mutable.update { s -> s.copy(providers = s.providers.map { if (it.id == providerId) it.copy(enabled = on) else it }) }
        }
        saveProviders(); saveChats()
    }
    suspend fun remove(providerId: String) = lock.withLock {
        ready()
        synchronized(gate) { invalidateProvider(providerId) }
        secrets.set(keySlot(providerId), null)
        synchronized(gate) { mutable.update { it.copy(providers = it.providers.filterNot { p -> p.id == providerId }) } }
        saveProviders(); saveChats()
    }

    private suspend fun <T> operation(providerId: String, block: suspend (PhoneProvider, String?) -> T): T = coroutineScope {
        renewSignIn(providerId)
        val lifetime = SupervisorJob(scope.coroutineContext[Job])
        lateinit var task: Deferred<T>
        task = async(lifetime, start = CoroutineStart.LAZY) {
            val (p, key) = lock.withLock {
                ready()
                currentCoroutineContext().ensureActive()
                val p = mutable.value.providers.first { it.id == providerId && it.enabled }
                p to secrets.get(keySlot(p.id))
            }
            currentCoroutineContext().ensureActive()
            block(p, key)
        }
        try {
            lock.withLock {
                ready()
                lifetime.ensureActive()
                check(mutable.value.providers.any { it.id == providerId && it.enabled }) { "Enable a provider first." }
                synchronized(gate) { operations.getOrPut(providerId) { mutableSetOf() }.add(task) }
            }
            task.start(); task.await()
        } finally {
            lifetime.cancel()
            synchronized(gate) {
                operations[providerId]?.let { jobs -> jobs.remove(task); if (jobs.isEmpty()) operations.remove(providerId) }
            }
        }
    }
    suspend fun models(providerId: String): List<PhoneModel> = operation(providerId) { p, key -> loadModels(p, key) }

    private suspend fun loadModels(p: PhoneProvider, key: String?): List<PhoneModel> {
        val job = currentCoroutineContext().job
        val token = Any()
        synchronized(gate) { job.ensureActive(); modelLoads[p.id] = token }
        return try {
            val request = PhoneProviders.modelsRequest(p, key)
            val models = if (request == null) PhoneProviders.kind(p.kind)!!.catalog else PhoneProviders.models(http.send(request), p.kind)
            require(models.isNotEmpty()) { "The provider listed no models." }
            synchronized(gate) {
                job.ensureActive()
                if (modelLoads[p.id] !== token) emptyList() else {
                    mutable.update { it.copy(models = it.models + (p.id to models), errors = it.errors - p.id) }
                    models
                }
            }
        } catch (e: CancellationException) { throw e } catch (_: Exception) {
            synchronized(gate) {
                job.ensureActive()
                if (modelLoads[p.id] === token) mutable.update { it.copy(models = it.models - p.id, errors = it.errors + (p.id to "Could not load models. Check the address, key and connection.")) }
            }
            emptyList()
        }
    }
    suspend fun test(providerId: String): String = operation(providerId) { p, key ->
        val list = loadModels(p, key)
        currentCoroutineContext().ensureActive()
        check(list.isNotEmpty()) { mutable.value.errors[providerId] ?: "No models." }
        if (PhoneProviders.kind(p.kind)!!.catalog.isNotEmpty()) {
            var answer = false; var complete = false
            val parser = PhoneStreamParser()
            val job = currentCoroutineContext().job
            try {
                http.send(PhoneProviders.chatRequest(p, key, list.first().id, listOf(PhoneMessage("test", "user", "Say OK.", now())), system = null, maxTokens = 8)) { line ->
                    synchronized(gate) {
                        job.ensureActive()
                        if (!complete) parser.line(line).forEach { event -> if (!complete) when (event) {
                            is PhoneStreamEvent.Text -> answer = answer || event.text.isNotBlank()
                            // A provider test is not a chat: its few tokens are not counted.
                            is PhoneStreamEvent.Usage -> Unit
                            is PhoneStreamEvent.Failure -> error(event.message)
                            PhoneStreamEvent.Done -> complete = true
                        } }
                        !complete
                    }
                }
                currentCoroutineContext().ensureActive()
                check(answer && complete) { "The provider did not finish a test reply." }
            } catch (e: CancellationException) { throw e } catch (_: Exception) {
                error("Could not finish a test reply. Check the provider and connection.")
            }
        }
        currentCoroutineContext().ensureActive()
        "Connection works."
    }
    suspend fun newChat(providerId: String, modelId: String): String = lock.withLock {
        ready()
        check(mutable.value.providers.any { it.id == providerId && it.enabled }) { "Enable a provider first." }
        check(mutable.value.models[providerId]?.any { it.id == modelId } == true) { "Choose a model." }
        val c = PhoneChat("phone:${id()}", "New chat", providerId, modelId, now(), now())
        synchronized(gate) { mutable.update { it.copy(chats = listOf(c) + it.chats) } }
        saveChats(); c.id
    }
    suspend fun forget(chatId: String) = lock.withLock {
        ready()
        synchronized(gate) {
            stop(chatId)
            mutable.update { it.copy(chats = it.chats.filterNot { c -> c.id == chatId }, errors = it.errors - chatId) }
        }
        saveChats()
    }
    fun stop(chatId: String) = synchronized(gate) {
        tasks[chatId]?.cancel()
        updateLast(chatId, null) { if (it.error == STREAMING) it.copy(error = "Stopped.") else it }
    }
    /** Whether a model takes photos. Unknown counts as yes: a model that can't says so in its reply. */
    fun acceptsImages(providerId: String, modelId: String): Boolean =
        mutable.value.models[providerId]?.firstOrNull { it.id == modelId }?.acceptsImages ?: true

    /** Send text, photos (image data URLs) or both; [retry] asks again for the last reply. */
    fun send(chatId: String, text: String, retry: Boolean = false, images: List<String> = emptyList()) = synchronized(gate) {
        val photos = images.filter { PhoneProviders.imagePart(it) != null }.take(PhoneProviders.MAX_IMAGES)
        if (!mutable.value.ready || tasks.containsKey(chatId) || (!retry && text.isBlank() && photos.isEmpty())) return@synchronized
        val attempt = id()
        lateinit var task: Job
        task = scope.launch(start = CoroutineStart.LAZY) {
            var started = false
            // What the provider reported for this reply, and where it ran, for this phone's usage.
            var usedIn = 0L
            var usedOut = 0L
            var ranOn: Triple<String, String, String>? = null
            try {
                mutable.value.chats.firstOrNull { it.id == chatId }?.providerId?.let { renewSignIn(it) }
                val request = lock.withLock {
                    currentCoroutineContext().ensureActive()
                    val old = mutable.value.chats.firstOrNull { it.id == chatId } ?: return@withLock null
                    val p = mutable.value.providers.firstOrNull { it.id == old.providerId && it.enabled } ?: return@withLock null
                    val key = secrets.get(keySlot(p.id))
                    synchronized(gate) prepare@ {
                        task.ensureActive()
                        val messages = if (retry) {
                            if (old.messages.lastOrNull()?.role != "assistant" || old.messages.dropLast(1).lastOrNull()?.role != "user") return@prepare null
                            old.messages.dropLast(1)
                        } else old.messages + PhoneMessage(id(), "user", text.trim(), now(), images = photos.ifEmpty { null })
                        val req = PhoneProviders.chatRequest(p, key, old.modelId, messages, system = mutable.value.tone.systemPrompt)
                        ranOn = Triple(p.id, p.label, old.modelId)
                        val next = old.copy(title = if (old.messages.isEmpty()) text.trim().lineSequence().first().take(60).ifEmpty { if (photos.isEmpty()) old.title else "Photo" } else old.title, updatedAt = now(), messages = messages + PhoneMessage(attempt, "assistant", "", now(), STREAMING))
                        mutable.update { s -> s.copy(chats = s.chats.map { if (it.id == chatId) next else it }, running = s.running + chatId, errors = s.errors - chatId) }
                        started = true
                        req
                    }?.also { saveChats() }
                } ?: return@launch
                currentCoroutineContext().ensureActive()
                val parser = PhoneStreamParser(); var complete = false
                http.send(request) { line ->
                    synchronized(gate) {
                        task.ensureActive()
                        if (!complete) parser.line(line).forEach { event -> if (!complete) when (event) {
                            is PhoneStreamEvent.Text -> updateLast(chatId, attempt) { it.copy(text = it.text + event.text) }
                            is PhoneStreamEvent.Usage -> { event.input?.let { usedIn = it }; event.output?.let { usedOut = it } }
                            is PhoneStreamEvent.Failure -> error(event.message)
                            PhoneStreamEvent.Done -> complete = true
                        } }
                        !complete
                    }
                }
                synchronized(gate) {
                    task.ensureActive()
                    check(complete) { "The reply ended early. Retry to try again." }
                    updateLast(chatId, attempt) { it.copy(error = null) }
                }
            } catch (e: CancellationException) {
                synchronized(gate) { if (started) updateLast(chatId, attempt) { it.copy(error = "Stopped.") } }
            } catch (e: Exception) {
                // A refusal is already in our own words (no credit, rate limited and so on).
                val why = if (e is ProviderRefusal) e.message.orEmpty() else "Reply failed. Check the provider and connection, then retry."
                synchronized(gate) {
                    if (started) updateLast(chatId, attempt) { it.copy(error = if (task.isActive) why else "Stopped.") }
                }
            } finally {
                withContext(NonCancellable) {
                    lock.withLock {
                        synchronized(gate) { mutable.update { it.copy(running = it.running - chatId) } }
                        // A stopped or failed reply still counts what the provider reported.
                        ranOn?.takeIf { started && (usedIn > 0 || usedOut > 0) }?.let { (pid, label, model) ->
                            synchronized(gate) { mutable.update { it.copy(usage = it.usage.record(pid, label, model, usedIn, usedOut, now())) } }
                            runCatching { saveUsage() }
                        }
                        try { if (started) saveChats() } catch (_: Exception) {
                            synchronized(gate) {
                                if (mutable.value.chats.any { it.id == chatId }) mutable.update { it.copy(errors = it.errors + (chatId to "Could not save this chat on the phone.")) }
                            }
                        } finally { synchronized(gate) { if (tasks[chatId] === task) tasks.remove(chatId) } }
                    }
                }
            }
        }
        tasks[chatId] = task
        // Also covers a scope cancelled before the lazy body ever runs.
        task.invokeOnCompletion { synchronized(gate) { if (tasks[chatId] === task) tasks.remove(chatId) } }
        task.start()
        Unit
    }
    // Called with gate held. Never let an old callback rewrite a newer assistant attempt.
    private fun updateLast(chatId: String, attempt: String?, transform: (PhoneMessage) -> PhoneMessage) {
        mutable.update { s -> s.copy(chats = s.chats.map { c ->
            if (c.id != chatId || c.messages.lastOrNull()?.role != "assistant" || (attempt != null && c.messages.last().id != attempt)) c
            else {
                val last = c.messages.last(); val next = transform(last)
                if (next == last) c else c.copy(updatedAt = now(), messages = c.messages.dropLast(1) + next)
            }
        }) }
    }
    companion object { const val STREAMING = "phone:streaming" }
}
