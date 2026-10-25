package com.nekko.android.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.panes.TabletopSplit

/**
 * A chat's body under its top bar ([top] tall): the [transcript], then the
 * [controls] (approval and question cards, the message box) above the keyboard.
 *
 * In tabletop ([tabletop] set: a folding phone half open on a table, hinge
 * horizontal) it is the flex layout: the transcript stops at the hinge; the
 * controls and the keyboard sit on the lower half, scrolling there if they are
 * taller than it. Nothing is drawn under the hinge line.
 */
@Composable
fun ChatColumns(top: Dp, tabletop: TabletopSplit?, transcript: @Composable (Modifier) -> Unit, controls: @Composable () -> Unit) {
    if (tabletop == null) {
        Column(Modifier.fillMaxSize().padding(top = top).imePadding()) {
            // Full width as well as the remaining height: without fillMaxWidth the box
            // wraps its content, so the loading spinner sat at the left edge.
            transcript(Modifier.weight(1f).fillMaxWidth())
            controls()
        }
        return
    }
    Column(Modifier.fillMaxSize().padding(top = top)) {
        transcript(Modifier.height((tabletop.above - top).coerceAtLeast(0.dp)).fillMaxWidth().clipToBounds())
        Spacer(Modifier.height(tabletop.hinge))
        Box(Modifier.weight(1f).fillMaxWidth().imePadding().clipToBounds(), contentAlignment = Alignment.BottomCenter) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) { controls() }
        }
    }
}
