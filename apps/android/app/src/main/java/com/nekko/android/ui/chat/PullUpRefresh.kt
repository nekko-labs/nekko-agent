package com.nekko.android.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import com.nekko.android.ui.theme.Nekko

/**
 * Pull **up** past the newest message to refresh an open chat, the iPhone's (#1779, #2117). Only a
 * finger's drag beyond the end counts (never a fling's leftover, never scrolling history), so
 * pulling down through older messages is left alone. Let go past [threshold] (pixels) and
 * [onRefresh] runs once; a refresh already running takes no second one. [onRefresh] must set
 * [refreshing] back to false when the reload ends, however it ends.
 */
class PullUpRefreshState(private val threshold: Float, private val atEnd: () -> Boolean) {
    var onRefresh: () -> Unit = {}

    /** How far past the end the finger has pulled, in pixels (damped). */
    var pulled by mutableFloatStateOf(0f)
        private set
    var refreshing by mutableStateOf(false)

    /** 0..1 of the way to a refresh, for the spinner. */
    val progress: Float get() = (pulled / threshold).coerceIn(0f, 1f)
    val armed: Boolean get() = pulled >= threshold

    val connection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            // Dragging back down while pulled: take the pull back first, the list stays put.
            if (pulled > 0f && available.y > 0f && source == NestedScrollSource.UserInput) {
                val back = minOf(available.y, pulled / DAMPING)
                pulled = (pulled - back * DAMPING).coerceAtLeast(0f)
                return Offset(0f, back)
            }
            return Offset.Zero
        }

        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            // What the list could not scroll, at its end, from a finger: that is the pull.
            if (source != NestedScrollSource.UserInput || available.y >= 0f || refreshing || !atEnd()) return Offset.Zero
            pulled = (pulled - available.y * DAMPING).coerceAtMost(threshold * 1.6f)
            return Offset(0f, available.y)
        }

        override suspend fun onPreFling(available: Velocity): Velocity {
            release()
            return Velocity.Zero
        }
    }

    /** The finger came up. */
    fun release() {
        val go = armed
        pulled = 0f
        if (go) refresh()
    }

    /** Pull-up, or the mascot's Refresh action: once at a time. */
    fun refresh() {
        if (refreshing) return
        refreshing = true
        onRefresh()
    }

    companion object {
        /** The pull follows the finger at half speed, so it reads as resistance. */
        const val DAMPING = 0.5f
    }
}

/** The spinner rising from the bottom while pulling, turning while the chat reloads. */
@Composable
fun PullUpIndicator(state: PullUpRefreshState, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val shown = state.refreshing || state.pulled > 0f
    if (!shown) return
    val rise = if (state.refreshing) 1f else state.progress
    Box(
        modifier
            .padding(bottom = 12.dp)
            .graphicsLayer { alpha = rise; translationY = (1f - rise) * 24.dp.toPx() }
            .size(36.dp)
            .shadow(3.dp, CircleShape)
            .background(p.surface, CircleShape)
            .testTag("chat.pullUpRefresh"),
    ) {
        if (state.refreshing) CircularProgressIndicator(color = p.accent, strokeWidth = 2.5.dp, modifier = Modifier.padding(8.dp))
        else CircularProgressIndicator(progress = { state.progress }, color = p.accent, strokeWidth = 2.5.dp, modifier = Modifier.padding(8.dp))
    }
}
