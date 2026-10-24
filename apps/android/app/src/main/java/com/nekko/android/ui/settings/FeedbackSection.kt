package com.nekko.android.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Feedback
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader

/** Settings → Feedback: opens [FeedbackSheet]. Sits just above About. */
@Composable
fun FeedbackSection(@Suppress("UNUSED_PARAMETER") deps: SettingsDeps) {
    var open by rememberSaveable { mutableStateOf(false) }
    SectionHeader("Feedback")
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            SettingsRow(
                title = "Send feedback",
                detail = "A bug or an idea, to the team that makes Nekko Agent",
                icon = Icons.Filled.Feedback,
                onClick = { open = true },
            )
        }
    }
    if (open) FeedbackSheet(onDismiss = { open = false })
}
