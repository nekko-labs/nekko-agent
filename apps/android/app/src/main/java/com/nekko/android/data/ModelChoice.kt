package com.nekko.android.data

import com.nekko.protocol.AUTO_MODEL_ID
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.SessionSummary

/** One provider's models in the picker, as the computer reported them. */
data class ModelGroup(
    val provider: PublicProvider,
    /** Null while the computer is still answering `models:list`. */
    val models: List<ModelInfo>?,
    /** The provider could not list its models (server off, request timed out). */
    val error: String? = null,
)

/** A concrete provider + model pair: what `session:setOptions` needs. */
data class ModelPick(val providerId: String, val modelId: String)

/**
 * How the phone chooses a model for a chat. The models live on the computer:
 * the phone lists what each enabled provider there reports (`models:list`)
 * and keeps nothing about them beyond the connection.
 *
 * Like the desktop's picker: every enabled provider's models in one list,
 * grouped by provider, the computer's starred models first. `Auto` is never
 * offered, because a chat started from the phone needs a concrete model.
 */
object ModelChoice {
    /**
     * The pick a new chat opens with: the computer's default model; else the
     * model of the most recently used chat (a computer that never set a default
     * still opens on something sensible); else nothing, and the user picks.
     * A candidate must still be listed by an enabled provider.
     */
    fun initial(defaults: RemoteDefaults, recent: List<SessionSummary>, groups: List<ModelGroup>): ModelPick? {
        val candidates = buildList {
            val dp = defaults.defaultProviderId
            val dm = defaults.defaultModelId?.takeIf { it != AUTO_MODEL_ID }
            if (dp != null && dm != null) add(ModelPick(dp, dm))
            recent.sortedByDescending { it.updatedAt }.forEach { s ->
                val p = s.providerId
                val m = s.modelId?.takeIf { it != AUTO_MODEL_ID }
                if (p != null && m != null) add(ModelPick(p, m))
            }
            favorites(defaults.favoriteModels).forEach { add(it) }
        }
        return candidates.firstOrNull { exists(it, groups) }
    }

    fun exists(pick: ModelPick, groups: List<ModelGroup>): Boolean =
        groups.any { g -> g.provider.id == pick.providerId && g.models?.any { it.id == pick.modelId } == true }

    /** The computer's starred models that are listed right now, in its order. */
    fun starred(groups: List<ModelGroup>, favoriteKeys: List<String>): List<Pair<PublicProvider, ModelInfo>> =
        favorites(favoriteKeys).mapNotNull { pick ->
            val g = groups.firstOrNull { it.provider.id == pick.providerId } ?: return@mapNotNull null
            g.models?.firstOrNull { it.id == pick.modelId }?.let { g.provider to it }
        }

    /** Case-insensitive match on model name, model id or provider label. */
    fun filter(groups: List<ModelGroup>, query: String): List<ModelGroup> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return groups
        return groups.mapNotNull { g ->
            if (g.provider.label.lowercase().contains(q)) return@mapNotNull g
            val hits = g.models?.filter { it.name.lowercase().contains(q) || it.id.lowercase().contains(q) }
            if (hits.isNullOrEmpty()) null else g.copy(models = hits)
        }
    }

    /** Still waiting on at least one provider. */
    fun loading(groups: List<ModelGroup>): Boolean = groups.any { it.models == null && it.error == null }

    /** `providerId::modelId` keys, as the desktop stores favorites. */
    private fun favorites(keys: List<String>): List<ModelPick> = keys.mapNotNull { key ->
        val i = key.indexOf("::")
        if (i <= 0 || i + 2 >= key.length) null else ModelPick(key.substring(0, i), key.substring(i + 2))
    }
}
