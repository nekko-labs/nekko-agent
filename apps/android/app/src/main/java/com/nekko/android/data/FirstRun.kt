package com.nekko.android.data

import com.nekko.android.connection.Notices

/**
 * First run (the iPhone's IO-31), three steps shown once: what the app does,
 * pairing, and notifications with a picture of what they look like. Step 3
 * comes right after the first pairing, so notifications are never asked about
 * before a computer is paired. Skip on step 1 or 2 ends it.
 */
object FirstRun {
    /** The first run is over (finished or skipped). */
    val DONE = PhonePrefs.boolean("first_run.done", default = false)

    /** Paired during the first run, step 3 not answered yet: shown again at the next start. */
    val NOTIFY_STEP = PhonePrefs.boolean("first_run.notify_step", default = false)

    /** At start: a phone paired before the first run existed never sees it. */
    fun atLaunch(prefs: PhonePrefs, hasComputers: Boolean) {
        if (hasComputers && !prefs.get(DONE) && !prefs.get(NOTIFY_STEP)) prefs.set(DONE, true)
    }

    /** A computer was paired: during the first run, step 3 is next. */
    fun paired(prefs: PhonePrefs) {
        if (!prefs.get(DONE)) prefs.set(NOTIFY_STEP, true)
    }

    /** Skip on step 1 or 2. */
    fun skip(prefs: PhonePrefs) = prefs.set(DONE, true)

    /**
     * Step 3's answer. *Not now* turns *Notify me* off (Android below 13 shows
     * notifications without asking, so the choice has to stick somewhere);
     * Settings → Connection turns it back on.
     */
    fun finish(prefs: PhonePrefs, allowNotifications: Boolean) {
        if (!allowNotifications) Notices.setAll(prefs, false)
        prefs.set(NOTIFY_STEP, false)
        prefs.set(DONE, true)
    }
}
