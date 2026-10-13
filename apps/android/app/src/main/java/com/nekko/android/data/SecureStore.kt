package com.nekko.android.data

/** Small string key/value store whose values are encrypted at rest ([AndroidSecureStore] on device). */
interface SecureStore {
    suspend fun get(key: String): String?

    /** `null` removes the entry. */
    suspend fun set(key: String, value: String?)
}
