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
    )
    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val lock = Mutex()
    private val tasks = mutableMapOf<String, Job>()
    private val revisions = mutableMapOf<String, Long>()
    private val providersSlot = "phone.providers.v1"
    private val chatsSlot = "phone.chats.v1"
    private fun keySlot(id: String) = "phone.provider.key.$id"
    private fun id() = UUID.randomUUID().toString()
    private fun now() = System.currentTimeMillis()

    suspend fun load() = lock.withLock {
        if (mutable.value.ready) return@withLock
        val providers = secrets.get(providersSlot)?.let { json.decodeFromString(ListSerializer(PhoneProvider.serializer()), it) }.orEmpty()
        val chats = secrets.get(chatsSlot)?.let { json.decodeFromString(ListSerializer(PhoneChat.serializer()), it) }.orEmpty().map { c ->
            c.copy(messages = c.messages.map { m -> if (m.role == "assistant" && m.error == STREAMING) m.copy(error = "Stopped when the app closed.") else m })
        }
        mutable.value = State(ready = true, providers = providers, chats = chats)
    }
    private suspend fun saveProviders() = secrets.set(providersSlot, json.encodeToString(ListSerializer(PhoneProvider.serializer()), mutable.value.providers))
    private suspend fun saveChats() = secrets.set(chatsSlot, json.encodeToString(ListSerializer(PhoneChat.serializer()), mutable.value.chats))

    suspend fun add(kind: String, label: String, url: String?, key: String?, workspace: String? = null): String = lock.withLock {
        val p = PhoneProviders.make(id(), kind, label, url, key, workspace)
        secrets.set(keySlot(p.id), key?.trim()?.ifEmpty { null })
        mutable.update { it.copy(providers = it.providers + p) }; saveProviders(); p.id
    }
    suspend fun setKey(providerId: String, key: String) = lock.withLock {
        val p = mutable.value.providers.first { it.id == providerId }
        PhoneProviders.make(p.id, p.kind, p.label, p.baseUrl, key, p.workspaceId)
        stopProvider(providerId)
        revisions[providerId] = (revisions[providerId] ?: 0) + 1
        secrets.set(keySlot(providerId), key.trim().ifEmpty { null })
        mutable.update { it.copy(models = it.models - providerId, errors = it.errors - providerId) }
    }
    private fun stopProvider(providerId: String) {
        mutable.value.chats.filter { it.providerId == providerId }.forEach { stop(it.id) }
    }
    suspend fun enabled(providerId: String, on: Boolean) = lock.withLock {
        revisions[providerId] = (revisions[providerId] ?: 0) + 1
        if (!on) stopProvider(providerId)
        mutable.update { s -> s.copy(providers = s.providers.map { if (it.id == providerId) it.copy(enabled = on) else it }) }; saveProviders()
    }
    suspend fun remove(providerId: String) = lock.withLock {
        stopProvider(providerId)
        secrets.set(keySlot(providerId), null)
        mutable.update { it.copy(providers = it.providers.filterNot { p -> p.id == providerId }, models = it.models - providerId, errors = it.errors - providerId) }
        saveProviders(); saveChats()
    }
    suspend fun models(providerId: String): List<PhoneModel> {
        val p = mutable.value.providers.firstOrNull { it.id == providerId && it.enabled } ?: return emptyList()
        val revision = revisions[providerId] ?: 0
        return try {
            val request = PhoneProviders.modelsRequest(p, secrets.get(keySlot(p.id)))
            val models = if (request == null) PhoneProviders.kind(p.kind)!!.catalog else PhoneProviders.models(http.send(request), p.kind)
            require(models.isNotEmpty()) { "The provider listed no models." }
            // Ignore an in-flight load after disable/remove/key replacement.
            if ((revisions[providerId] ?: 0) == revision && mutable.value.providers.contains(p)) mutable.update { it.copy(models = it.models + (p.id to models), errors = it.errors - p.id) }
            models
        } catch (e: CancellationException) { throw e } catch (_: Exception) {
            mutable.update { it.copy(models = it.models - p.id, errors = it.errors + (p.id to "Could not load models. Check the address, key and connection.")) }; emptyList()
        }
    }
    suspend fun test(providerId: String): String {
        val p = mutable.value.providers.first { it.id == providerId && it.enabled }
        val list = models(providerId)
        check(list.isNotEmpty()) { mutable.value.errors[providerId] ?: "No models." }
        if (PhoneProviders.kind(p.kind)!!.catalog.isNotEmpty()) {
            var answer = false; var complete = false
            val parser = PhoneStreamParser()
            http.send(PhoneProviders.chatRequest(p, secrets.get(keySlot(p.id)), list.first().id, listOf(PhoneMessage("test", "user", "Say OK.", now())), system = null, maxTokens = 8)) { line ->
                parser.line(line).forEach { event -> when (event) {
                    is PhoneStreamEvent.Text -> answer = answer || event.text.isNotBlank()
                    is PhoneStreamEvent.Failure -> error(event.message)
                    PhoneStreamEvent.Done -> complete = true
                } }
                !complete
            }
            check(answer && complete) { "The provider did not finish a test reply." }
        }
        return "Connection works."
    }
    suspend fun newChat(providerId: String, modelId: String): String = lock.withLock {
        check(mutable.value.providers.any { it.id == providerId && it.enabled }) { "Enable a provider first." }
        check(mutable.value.models[providerId]?.any { it.id == modelId } == true) { "Choose a model." }
        val c = PhoneChat("phone:${id()}", "New chat", providerId, modelId, now(), now())
        mutable.update { it.copy(chats = listOf(c) + it.chats) }; saveChats(); c.id
    }
    suspend fun forget(chatId: String) = lock.withLock {
        stop(chatId)
        mutable.update { it.copy(chats = it.chats.filterNot { c -> c.id == chatId }) }; saveChats()
    }
    fun stop(chatId: String) { tasks[chatId]?.cancel() }
    fun send(chatId: String, text: String, retry: Boolean = false) {
        if (tasks[chatId]?.isActive == true || chatId in mutable.value.running || (!retry && text.isBlank())) return
        // LAZY ensures the job is registered before its finally block can remove it.
        val task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val c = lock.withLock {
                    val old = mutable.value.chats.first { it.id == chatId }
                    check(mutable.value.providers.any { it.id == old.providerId && it.enabled }) { "This provider is disabled or removed." }
                    val messages = if (retry) {
                        check(old.messages.lastOrNull()?.role == "assistant") { "Nothing to retry." }
                        old.messages.dropLast(1)
                    } else old.messages + PhoneMessage(id(), "user", text.trim(), now())
                    val next = old.copy(title = if (old.messages.isEmpty()) text.trim().lineSequence().first().take(60) else old.title, updatedAt = now(), messages = messages + PhoneMessage(id(), "assistant", "", now(), STREAMING))
                    mutable.update { s -> s.copy(chats = s.chats.map { if (it.id == chatId) next else it }, running = s.running + chatId, errors = s.errors - chatId) }
                    saveChats(); next
                }
                val p = mutable.value.providers.first { it.id == c.providerId && it.enabled }
                val parser = PhoneStreamParser(); var complete = false
                http.send(PhoneProviders.chatRequest(p, secrets.get(keySlot(p.id)), c.modelId, c.messages.dropLast(1))) { line ->
                    parser.line(line).forEach { event -> when (event) {
                        is PhoneStreamEvent.Text -> updateLast(chatId) { it.copy(text = it.text + event.text) }
                        is PhoneStreamEvent.Failure -> error(event.message)
                        PhoneStreamEvent.Done -> complete = true
                    } }
                    !complete
                }
                check(complete) { "The reply ended early. Retry to try again." }
                updateLast(chatId) { it.copy(error = null) }
            } catch (e: CancellationException) {
                updateLast(chatId) { it.copy(error = "Stopped.") }
            } catch (_: Exception) {
                updateLast(chatId) { it.copy(error = "Reply failed. Check the provider and connection, then retry.") }
                mutable.update { it.copy(errors = it.errors + (chatId to "Check that the provider is enabled and its key works.")) }
            } finally {
                withContext(NonCancellable) {
                    lock.withLock {
                        mutable.update { it.copy(running = it.running - chatId) }
                        saveChats()
                    }
                }
                tasks.remove(chatId)
            }
        }
        tasks[chatId] = task; task.start()
    }
    private fun updateLast(chatId: String, transform: (PhoneMessage) -> PhoneMessage) {
        mutable.update { s -> s.copy(chats = s.chats.map { c ->
            if (c.id != chatId || c.messages.lastOrNull()?.role != "assistant") c
            else c.copy(updatedAt = now(), messages = c.messages.dropLast(1) + transform(c.messages.last()))
        }) }
    }
    companion object { const val STREAMING = "phone:streaming" }
}
