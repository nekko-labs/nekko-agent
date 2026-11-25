package com.nekko.android.baselineprofile

import android.content.Intent
import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.Until

/** The app under test: the release build's id (`applicationId` in `:app`). */
const val TARGET_PACKAGE = "com.nekko.native.android"

/** Opens the benchmark-only 300-message chat screen (`LongChatBenchmarkActivity`), in [mode]. */
fun MacrobenchmarkScope.startLongChat(mode: String) {
    startActivityAndWait(
        Intent().setClassName(TARGET_PACKAGE, "com.nekko.android.LongChatBenchmarkActivity").putExtra("mode", mode),
    )
    device.wait(Until.hasObject(By.res("chat-list")), 10_000)
}

/** Flings the long chat up and down, as a person reading back through it. */
fun MacrobenchmarkScope.scrollLongChat(rounds: Int = 3) {
    val list = device.findObject(By.res("chat-list")) ?: error("the long chat is not on screen")
    // Keep clear of the system gesture areas at the edges.
    list.setGestureMargin(device.displayWidth / 5)
    repeat(rounds) {
        list.fling(Direction.UP)
        device.waitForIdle()
        list.fling(Direction.DOWN)
        device.waitForIdle()
    }
}
