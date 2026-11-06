package com.nekko.android.providers

import com.nekko.protocol.Channels
import com.nekko.protocol.ProviderSaveResult
import com.nekko.protocol.ProviderSetup
import com.nekko.protocol.RelayException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * Adding a provider to a computer and switching one on or off, from the phone
 * (AN-36, the iPhone's `ProviderSetupModel`, decision 0016). The key the user
 * typed is sealed to the computer's own key for one call and never kept; both
 * the save and the switch are Change actions (signed: the fingerprint, face or
 * screen lock, once per 5 minutes).
 */
class ProviderSetupController(
    /** A plain read (`providers:sealKey`). */
    private val read: suspend (String) -> JsonElement,
    /** A signed Change, with a timeout in ms (the computer tests a new provider before answering). */
    private val change: suspend (String, List<JsonElement>, Long?) -> JsonElement,
    /** After a change: read the computer's providers and models again. */
    private val changed: suspend () -> Unit,
) {
    /** Seal [key] to the computer and save the provider there; the models it can now use, or why not (thrown). */
    suspend fun save(id: String, kind: String, label: String, baseUrl: String?, key: String?): ProviderSaveResult {
        val computerKey = ProviderSetup.computerKey(read(Channels.PROVIDERS_SEAL_KEY))
        val request = ProviderSetup.request(id, kind, label, baseUrl, key, computerKey)
        val result = ProviderSaveResult.from(change(Channels.PROVIDERS_SAVE_SEALED, listOf(request), SAVE_MS))
        if (!result.ok) throw RelayException(result.message ?: "The computer couldn’t save the provider.")
        changed()
        return result
    }

    /** Turn one provider on or off on the computer. */
    suspend fun setEnabled(id: String, enabled: Boolean) {
        val result = ProviderSaveResult.from(change(Channels.PROVIDERS_SET_ENABLED, listOf(JsonPrimitive(id), JsonPrimitive(enabled)), null))
        changed()
        if (!result.ok) throw RelayException(result.message ?: "The computer couldn’t change the provider.")
    }

    companion object {
        /** The computer lists the provider's models before it answers. */
        const val SAVE_MS = 60_000L
    }
}
