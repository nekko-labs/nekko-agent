package com.nekko.android.phone

import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.PhoneProviders

/**
 * Settings → Beta → cloud models on this phone: chats straight from the phone to a cloud
 * provider on the user's own key ([PhoneChats]). Off for a new install; an install that already
 * used them keeps them on ([PhoneProviders.betaOn]). Saved on this phone only.
 */
object PhoneCloudBeta {
    /** The user's choice; null until one is made. */
    val KEY: PhonePrefs.Key<Boolean?> = PhonePrefs.key("phoneCloudBeta", null, { it.toString() }, { it.toBooleanStrictOrNull() })

    /** At launch, before the store loads: the stored choice, else off. */
    fun atLaunch(prefs: PhonePrefs, phone: PhoneChats) = phone.setAvailable(prefs.get(KEY) ?: false)

    /** Once the store has loaded: with no choice made yet, a phone that used them keeps them, for good. */
    fun afterLoad(prefs: PhonePrefs, phone: PhoneChats) {
        if (prefs.get(KEY) != null) return
        if (PhoneProviders.betaOn(stored = null, hasAnything = phone.hasAnything)) {
            prefs.set(KEY, true)
            phone.setAvailable(true)
        }
    }

    /** The Settings switch. */
    fun set(prefs: PhonePrefs, phone: PhoneChats, on: Boolean) {
        prefs.set(KEY, on)
        phone.setAvailable(on)
    }
}
