package com.nekko.android.ui.settings

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nekko.android.R
import com.nekko.android.connection.StatusDashboard
import com.nekko.protocol.LiveCard
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.LiveChat
import com.nekko.protocol.LiveChatState
import com.nekko.protocol.LiveLevel

/**
 * The Settings preview's sample, built the way [com.nekko.android.connection.ConnectionKeeper]
 * builds the real card ([LiveCard.build]) at the chosen level: one chat waiting
 * on an approval, one working, one watching a PR and one done, as on the iPhone.
 */
object LiveCardSample {
    const val COMPUTER = "Mac"

    fun card(level: LiveLevel, now: Double): LiveCardState? = LiveCard.build(chats(now), null, null, level, now)

    /** How many sample chats are running, for the plain notification at None. */
    fun running(now: Double): Int = chats(now).count { !it.state.finished }

    private fun chats(now: Double) = listOf(
        LiveChat(id = "billing", short = "Billing", state = LiveChatState.NEEDS_YOU, step = "Run npm test", reply = "Want me to run the tests first?",
            closeWord = "Nice", startedAt = now - 754, callId = "sample", severity = "low", title = "Billing page redesign"),
        LiveChat(id = "login", short = "Login", state = LiveChatState.WORKING, step = "Fixing merge conflicts", reply = "Got it. Working on it now.",
            closeWord = "Cool", startedAt = now - 312, title = "Fix the login redirect"),
        LiveChat(id = "ios", short = "iOS LA", state = LiveChatState.WATCHING, step = "Watching PR #1211…", reply = "PR is up.", closeWord = "Perfect"),
        LiveChat(id = "docs", short = "Docs", state = LiveChatState.DONE, step = "Finished", reply = "Docs page added.", closeWord = "Looks good", finishedAt = now),
    )
}

/**
 * A dark lock screen with the Lock Screen card drawn as [com.nekko.android.connection.Notices.keepAlive]
 * builds it at [level]: the plain "Staying connected" notification at None,
 * else the content-free totals with Talk and Open. The level change cross-fades
 * in 0.2 s, like the iPhone's Settings preview.
 */
@Composable
fun LockScreenCardPreview(level: LiveLevel, modifier: Modifier = Modifier) {
    val now = System.currentTimeMillis() / 1000.0
    val description = stringResource(R.string.settings_card_preview)
    Column(
        modifier
            .fillMaxWidth()
            .heightIn(min = 220.dp)
            .background(Brush.verticalGradient(listOf(Color(0xFF1A1F38), Color(0xFF08080F))), RoundedCornerShape(28.dp))
            .padding(16.dp)
            .semantics { contentDescription = description }
            .testTag("settings.card.preview"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("9:41", fontSize = 48.sp, fontWeight = FontWeight.SemiBold, color = Color.White.copy(alpha = 0.9f))
        Crossfade(level, animationSpec = tween(200), label = "card level") { shown ->
            val card = LiveCardSample.card(shown, now)
            if (card == null) {
                val running = LiveCardSample.running(now)
                NotificationDrawing(
                    title = stringResource(R.string.chat_notice_staying_connected),
                    lines = listOf(
                        if (running == 1) stringResource(R.string.chat_notice_running_one, LiveCardSample.COMPUTER)
                        else stringResource(R.string.chat_notice_running_other, running, LiveCardSample.COMPUTER),
                    ),
                    actions = emptyList(),
                    tag = "settings.card.preview.plain",
                )
            } else {
                NotificationDrawing(
                    title = stringResource(R.string.app_name),
                    lines = StatusDashboard.lines(card, stringResource(R.string.dashboard_voice_fallback)),
                    actions = listOf(stringResource(R.string.dashboard_talk), stringResource(R.string.dashboard_open)),
                    tag = "settings.card.preview.card",
                )
            }
        }
    }
}

/** A notification shade card: the app's name, its lines and its action labels. */
@Composable
private fun NotificationDrawing(title: String, lines: List<String>, actions: List<String>, tag: String) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Color(0xEB24262E), RoundedCornerShape(22.dp))
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .testTag(tag),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = Color.White)
        for (line in lines) Text(line, style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.75f))
        if (actions.isNotEmpty()) {
            Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                for (action in actions) Text(action, style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = 0.9f))
            }
        }
    }
}
