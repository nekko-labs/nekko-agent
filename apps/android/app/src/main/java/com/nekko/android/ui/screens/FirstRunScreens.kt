package com.nekko.android.ui.screens

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
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.VerifiedUser
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
    Text("Step $step of 3", style = MaterialTheme.typography.labelLarge, color = Nekko.palette.inkSoft)
}

/** A first-run page: Skip at the top when offered, the content scrolling, the buttons pinned at the bottom. */
@Composable
private fun FirstRunPage(onSkip: (() -> Unit)?, buttons: @Composable () -> Unit, content: @Composable () -> Unit) {
    val p = Nekko.palette
    Column(Modifier.fillMaxSize().background(p.paper).statusBarsPadding().navigationBarsPadding()) {
        Box(Modifier.fillMaxWidth().heightIn(min = 48.dp), contentAlignment = Alignment.CenterEnd) {
            if (onSkip != null) TextButton(onClick = onSkip, modifier = Modifier.testTag("firstRun.skip")) { Text("Skip") }
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
            Button(onClick = onContinue, modifier = Modifier.fillMaxWidth().height(48.dp).testTag("firstRun.continue")) { Text("Continue") }
        },
    ) {
        StepLabel(1)
        // The opening screen's mark: the cat is a third of its square, so it is drawn larger than its slot.
        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
            Image(painterResource(R.drawable.splash_mark), contentDescription = null, modifier = Modifier.requiredSize(196.dp))
        }
        Text(
            "Your agent, in your pocket",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = p.ink,
            modifier = Modifier.semantics { heading() },
        )
        Text("Nekko Agent runs on your computer. This app lets you drive it from anywhere.", style = MaterialTheme.typography.bodyLarge, color = p.inkSoft)
        Point(Icons.Filled.Forum, "Follow chats as they stream", "Watch your computer work, and start new chats from here.")
        Point(Icons.Filled.VerifiedUser, "Approve tools and answer questions", "When the agent needs you, you decide.")
        Point(Icons.Filled.Lock, "Private by design", "Everything is end-to-end encrypted between this phone and your computer.")
    }
}

@Composable
private fun Point(icon: ImageVector, title: String, text: String) {
    val p = Nekko.palette
    Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(icon, contentDescription = null, tint = p.accent, modifier = Modifier.padding(top = 2.dp).size(24.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = p.ink)
            Text(text, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
        }
    }
}

/**
 * Step 3, right after the first pairing: what notifications look like, then
 * Android's own question (13 and later; older versions don't ask). *Not now*
 * leaves them off; Settings → Connection → Notify me turns them on.
 */
@Composable
fun FirstRunNotifications(computer: String, asking: Boolean, onAllow: () -> Unit, onNotNow: () -> Unit) {
    val p = Nekko.palette
    FirstRunPage(
        onSkip = null,
        buttons = {
            Button(onClick = onAllow, enabled = !asking, modifier = Modifier.fillMaxWidth().height(48.dp).testTag("firstRun.allowNotifications")) {
                Text("Allow notifications")
            }
            TextButton(onClick = onNotNow, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("firstRun.notNow")) { Text("Not now") }
        },
    ) {
        StepLabel(3)
        Text(
            "Know when your computer needs you",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = p.ink,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            "A notification when a tool waits for your approval, when the agent asks a question, and when a reply finishes or fails.",
            style = MaterialTheme.typography.bodyLarge,
            color = p.inkSoft,
        )
        Column(
            Modifier.clearAndSetSemantics { contentDescription = "Preview: an approval with Deny, and a finished reply." },
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            NotificationPreview("Needs your approval", "$computer · Open Nekko to see it.", deny = true)
            NotificationPreview("Reply ready", "$computer · Open Nekko to see it.", deny = false)
        }
        Text(
            "Notifications say only what happened, never what your chats say. You can change them in Settings.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkSoft,
        )
    }
}

/** A drawing of a notification in the shade, so step 3 shows what to expect. */
@Composable
private fun NotificationPreview(title: String, text: String, deny: Boolean) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(18.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(28.dp).clip(RoundedCornerShape(8.dp)).background(p.accent), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, tint = p.accentInk, modifier = Modifier.size(28.dp))
            }
            Column(Modifier.weight(1f)) {
                Row {
                    Text("Nekko Agent · now", style = MaterialTheme.typography.labelMedium, color = p.inkSoft)
                }
                Text(title, style = MaterialTheme.typography.titleSmall, color = p.ink)
                Text(text, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
            }
        }
        if (deny) {
            Row(Modifier.padding(start = 38.dp)) {
                Text("Deny", style = MaterialTheme.typography.labelLarge, color = p.danger, modifier = Modifier.width(80.dp))
            }
        }
    }
}
