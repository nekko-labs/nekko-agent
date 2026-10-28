package com.nekko.android.ui.simple

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.SimpleMode
import com.nekko.android.data.SimpleVisibility
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.ui.theme.Nekko

/** The mode and the person's choices, as the screens read them. */
class SimpleView(val expert: Boolean, val choices: Map<String, SimpleVisibility>, val setExpert: (Boolean) -> Unit) {
    fun shown(id: String) = SimpleMode.shown(id, expert, choices)

    companion object {
        /** Outside the app's provider (previews, tests of one component): every control shows. */
        val ALL = SimpleView(expert = true, choices = emptyMap()) {}
    }
}

val LocalSimple = staticCompositionLocalOf { SimpleView.ALL }

@Composable
fun rememberSimpleView(prefs: PhonePrefs): SimpleView {
    val expert by prefs.flow(EXPERT_MODE).collectAsStateWithLifecycle()
    val raw by prefs.flow(SimpleMode.CHOICES).collectAsStateWithLifecycle()
    return remember(expert, raw, prefs) { SimpleView(expert, SimpleMode.parse(raw)) { prefs.set(EXPERT_MODE, it) } }
}

/** A pill of segments, the selected one tinted with the accent. */
@Composable
fun <T> Segments(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    height: Dp = 40.dp,
    describe: (T) -> String,
    content: @Composable RowScope.(option: T, on: Boolean) -> Unit,
) {
    val p = Nekko.palette
    val shape = RoundedCornerShape(999.dp)
    Row(
        modifier.clip(shape).background(p.surface2).border(1.dp, p.line, shape).padding(2.dp).selectableGroup(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { o ->
            val on = o == selected
            Row(
                Modifier
                    .weight(1f, fill = false)
                    .heightIn(min = height)
                    .widthIn(min = 48.dp)
                    .clip(shape)
                    .background(if (on) p.accent else p.surface2)
                    .selectable(on, role = Role.RadioButton) { if (!on) onSelect(o) }
                    .semantics { contentDescription = describe(o) }
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) { content(o, on) }
        }
    }
}

/** Text segments: Simple | Expert, or Show / Expert only / Hide. */
@Composable
fun <T> TextSegments(options: List<T>, selected: T, onSelect: (T) -> Unit, label: (T) -> String, modifier: Modifier = Modifier, describe: (T) -> String = label) {
    val p = Nekko.palette
    Segments(options, selected, onSelect, modifier, describe = describe) { o, on ->
        Text(
            label(o), style = MaterialTheme.typography.labelLarge, color = if (on) p.accentInk else p.ink,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(min = 40.dp),
        )
    }
}

const val MODE_SWITCH_TAG = "simple.mode"
const val SIMPLE_DESCRIPTION = "Simple: everyday controls"
const val EXPERT_DESCRIPTION = "Expert: every control"

/** Simple (a chat bubble) or Expert (angle brackets), at the top left of Chats and of every chat. */
@Composable
fun ModeSwitch(expert: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Box(modifier.padding(horizontal = 4.dp).testTag(MODE_SWITCH_TAG)) {
        Segments(
            options = listOf(false, true), selected = expert, onSelect = onChange,
            describe = { if (it) EXPERT_DESCRIPTION else SIMPLE_DESCRIPTION },
        ) { o, on ->
            Icon(
                if (o) Icons.Filled.Code else Icons.Filled.ChatBubbleOutline,
                contentDescription = null,
                tint = if (on) p.accentInk else p.inkSoft,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
