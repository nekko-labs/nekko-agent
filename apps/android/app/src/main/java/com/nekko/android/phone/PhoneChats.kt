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
        synchronized(gate) { mutable.value = State(ready = true, providers = providers, chats = chats, usage = usage) }
    }
    private suspend fun saveProviders() = secrets.set(providersSlot, json.encodeToString(ListSerializer(PhoneProvider.serializer()), mutable.value.providers))
    private suspend fun saveChats() = secrets.set(chatsSlot, json.encodeToString(ListSerializer(PhoneChat.serializer()), mutable.value.chats))
    private suspend fun saveUsage() = secrets.set(usageSlot, mutable.value.usage.json().toString())

    suspend fun add(kind: String, label: String, url: String?, key: String?, workspace: String? = null): String = lock.withLock {
        ready()
        val p = PhoneProviders.make(id(), kind, label, url, key, workspace)
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
    fun send(chatId: String, text: String, retry: Boolean = false) = synchronized(gate) {
        if (!mutable.value.ready || tasks.containsKey(chatId) || (!retry && text.isBlank())) return@synchronized
        val attempt = id()
        lateinit var task: Job
        task = scope.launch(start = CoroutineStart.LAZY) {
            var started = false
            // What the provider reported for this reply, and where it ran, for this phone's usage.
            var usedIn = 0L
            var usedOut = 0L
            var ranOn: Triple<String, String, String>? = null
            try {
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
                        } else old.messages + PhoneMessage(id(), "user", text.trim(), now())
                        val req = PhoneProviders.chatRequest(p, key, old.modelId, messages)
                        ranOn = Triple(p.id, p.label, old.modelId)
                        val next = old.copy(title = if (old.messages.isEmpty()) text.trim().lineSequence().first().take(60) else old.title, updatedAt = now(), messages = messages + PhoneMessage(attempt, "assistant", "", now(), STREAMING))
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
            } catch (_: Exception) {
                synchronized(gate) {
                    if (started) updateLast(chatId, attempt) { it.copy(error = if (task.isActive) "Reply failed. Check the provider and connection, then retry." else "Stopped.") }
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
