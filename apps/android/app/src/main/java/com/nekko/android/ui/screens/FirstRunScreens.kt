package com.nekko.android.ui.screens

import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko

/** "Step 2 of 3" over each first-run screen. */
@Composable
internal fun StepLabel(step: Int) {
    Text(stringResource(R.string.chats_step_of, step), style = MaterialTheme.typography.labelLarge, color = Nekko.palette.inkSoft)
}

/** A first-run page: Skip at the top when offered, the content scrolling, the buttons pinned at the bottom. */
@Composable
private fun FirstRunPage(onSkip: (() -> Unit)?, buttons: @Composable () -> Unit, content: @Composable () -> Unit) {
    val p = Nekko.palette
    Column(Modifier.fillMaxSize().background(p.paper).statusBarsPadding().navigationBarsPadding()) {
        Box(Modifier.fillMaxWidth().heightIn(min = 48.dp), contentAlignment = Alignment.CenterEnd) {
            if (onSkip != null) TextButton(onClick = onSkip, modifier = Modifier.testTag("firstRun.skip")) { Text(stringResource(R.string.chats_skip)) }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) { content() }
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            buttons()
        }
    }
}

/** Step 1: what the app does. */
@Composable
fun FirstRunIntro(onContinue: () -> Unit, onSkip: () -> Unit) {
    val p = Nekko.palette
    FirstRunPage(
        onSkip = onSkip,
        buttons = {
            Button(onClick = onContinue, modifier = Modifier.fillMaxWidth().height(48.dp).testTag("firstRun.continue")) { Text(stringResource(R.string.chats_continue)) }
        },
    ) {
        StepLabel(1)
        // The opening screen's mark: the cat is a third of its square, so it is drawn larger than its slot.
        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
            Image(painterResource(R.drawable.splash_mark), contentDescription = null, modifier = Modifier.requiredSize(196.dp))
        }
        Text(
            stringResource(R.string.chats_intro_title),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = p.ink,
            modifier = Modifier.semantics { heading() },
        )
        Text(stringResource(R.string.chats_intro_body), style = MaterialTheme.typography.bodyLarge, color = p.inkSoft)
        Point(Icons.Outlined.Forum, stringResource(R.string.chats_intro_follow_title), stringResource(R.string.chats_intro_follow_text))
        Point(Icons.Outlined.VerifiedUser, stringResource(R.string.chats_intro_approve_title), stringResource(R.string.chats_intro_approve_text))
        Point(Icons.Outlined.Lock, stringResource(R.string.chats_intro_private_title), stringResource(R.string.chats_intro_private_text))
    }
}

@Composable
private fun Point(icon: ImageVector, title: String, text: String) {
    val p = Nekko.palette
    Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(icon, contentDescription = null, tint = p.inkSoft, modifier = Modifier.padding(top = 2.dp).size(24.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = p.ink)
            Text(text, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
        }
    }
}
