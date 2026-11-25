package com.nekko.android.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Generates the app's Baseline Profile (`app/src/release/generated/baselineProfiles/`): cold start, then
 * a long chat drawn by the chat's own blocks and scrolled, so the scroll path is compiled ahead of time.
 *
 * Run on a device or emulator (API 28+): `./gradlew :app:generateBaselineProfile`. Commit the result.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(packageName = TARGET_PACKAGE, includeInStartupProfile = true) {
        // Cold start: the lock screen or the computer list, whichever the install opens on.
        pressHome()
        startActivityAndWait()
        // A long chat and its scroll.
        startLongChat("scroll")
        scrollLongChat()
    }
}
