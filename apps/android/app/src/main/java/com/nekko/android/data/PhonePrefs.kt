package com.nekko.android.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where [PhonePrefs] keeps its strings; a seam so the logic runs on the JVM without Android. */
interface PrefStore {
    fun getString(name: String): String?

    /** null removes the value. */
    fun putString(name: String, value: String?)
}

/** A plain preferences file. The manifest's backup rules exclude every preferences file from backup and device transfer. */
class SharedPrefStore(context: Context, file: String) : PrefStore {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences(file, Context.MODE_PRIVATE)

    override fun getString(name: String): String? = prefs.getString(name, null)

    override fun putString(name: String, value: String?) = prefs.edit { if (value == null) remove(name) else putString(name, value) }
}

/**
 * The phone's own non-secret settings, one [StateFlow] per key. Secrets (pairing keys) never go
 * here: they live in [SecureStore]. Declare each key once, next to the feature that owns it:
 *
 * ```
 * val HAPTICS = PhonePrefs.boolean("haptics", default = true)
 * val on by phonePrefs.flow(HAPTICS).collectAsStateWithLifecycle()
 * ```
 *
 * Values are stored as strings; one that no longer decodes (an enum constant that was removed,
 * say) reads as the key's default instead of failing. The appearance choice predates this store
 * and stays in [ThemePrefs].
 */
class PhonePrefs(private val store: PrefStore) {
    constructor(context: Context) : this(SharedPrefStore(context, FILE))

    class Key<T> @PublishedApi internal constructor(
        val name: String,
        val default: T,
        internal val encode: (T) -> String,
        internal val decode: (String) -> T?,
    ) {
        override fun toString() = "PhonePrefs.Key($name)"
    }

    private class Entry<T>(val key: Key<T>, val flow: MutableStateFlow<T>) {
        /** Handed out by [flow], the same instance every time. */
        val readOnly: StateFlow<T> = flow.asStateFlow()
    }

    private val entries = HashMap<String, Entry<*>>()

    fun <T> flow(key: Key<T>): StateFlow<T> = entry(key).readOnly

    fun <T> get(key: Key<T>): T = entry(key).flow.value

    fun <T> set(key: Key<T>, value: T) {
        val flow = entry(key).flow
        store.putString(key.name, key.encode(value))
        flow.value = value
    }

    /** Back to the default, forgetting the stored value. */
    fun <T> reset(key: Key<T>) {
        val flow = entry(key).flow
        store.putString(key.name, null)
        flow.value = key.default
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> entry(key: Key<T>): Entry<T> = synchronized(entries) {
        val existing = entries[key.name]
        check(existing == null || existing.key === key) { "Two PhonePrefs keys are named \"${key.name}\"" }
        (existing ?: Entry(key, MutableStateFlow(read(key))).also { entries[key.name] = it }) as Entry<T>
    }

    private fun <T> read(key: Key<T>): T =
        store.getString(key.name)?.let { runCatching { key.decode(it) }.getOrNull() } ?: key.default

    companion object {
        /** Its own file, so nothing here can collide with [ThemePrefs] (`nekko_ui`). */
        const val FILE = "nekko_phone"

        fun boolean(name: String, default: Boolean) = key(name, default, { it.toString() }, { it.toBooleanStrictOrNull() })

        fun int(name: String, default: Int) = key(name, default, { it.toString() }, { it.toIntOrNull() })

        fun long(name: String, default: Long) = key(name, default, { it.toString() }, { it.toLongOrNull() })

        fun string(name: String, default: String) = key(name, default, { it }, { it })

        /** Stored by constant name, so reordering the enum is safe; renaming a constant resets it to [default]. */
        inline fun <reified E : Enum<E>> enum(name: String, default: E): Key<E> =
            key(name, default, { it.name }, { stored -> enumValues<E>().firstOrNull { it.name == stored } })

        @PublishedApi
        internal fun <T> key(name: String, default: T, encode: (T) -> String, decode: (String) -> T?): Key<T> {
            require(name.isNotBlank()) { "PhonePrefs keys need a name" }
            return Key(name, default, encode, decode)
        }
    }
}
