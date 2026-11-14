package com.nekko.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.nekko.android.R
import com.nekko.android.ui.simple.rememberReduceMotion
import com.nekko.android.ui.theme.Nekko
import kotlinx.coroutines.delay

/**
 * "NAME is reconnecting..." over "Draft your message now and it will send when NAME reconnects"
 * (the iPhone's ReconnectingNotice, #2475). The three dots always take their full width; only
 * their opacity cycles, every 0.4 s, so nothing beside them moves. With animations off they stay
 * still and all shown; the cycle stops while the app is in the background.
 */
@Composable
fun ReconnectingNotice(name: String, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val still = rememberReduceMotion()
    var visible by remember { mutableIntStateOf(3) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(still, lifecycle) {
        if (still) { visible = 3; return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                visible = visible % 3 + 1
                delay(400)
            }
        }
    }
    val label = stringResource(R.string.chats_reconnecting_label, name)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // The tag says how many dots show, for tests; screen readers hear the line once, as "…".
        Box(Modifier.testTag("reconnect.dots.$visible")) {
            Row(Modifier.testTag("reconnect.title").clearAndSetSemantics { contentDescription = label }) {
                Text(stringResource(R.string.chats_reconnecting, name), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, color = p.inkSoft)
                for (i in 0 until 3) {
                    Text(".", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, color = p.inkSoft, modifier = Modifier.alpha(if (i < visible) 1f else 0f))
                }
            }
        }
        Text(stringResource(R.string.chats_reconnect_draft, name), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.testTag("reconnect.draft"))
    }
}
