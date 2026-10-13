package com.nekko.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.ui.chat.ApprovalCard
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.chat.QuestionCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Block
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ChatViewModel, onBack: () -> Unit) {
    val chat by vm.ui.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val list = rememberLazyListState()

    // Stable keys: a provider that reuses a call id across turns gets a suffix.
    val keyed = remember(chat.blocks) {
        val seen = HashMap<String, Int>()
        chat.blocks.map { b ->
            val kind = when (b) {
                is Block.User -> "user"
                is Block.Assistant -> "assistant"
                is Block.Tool -> "tool"
            }
            val base = "$kind:${b.id}"
            val n = seen.getOrDefault(base, 0)
            seen[base] = n + 1
            (if (n > 0) "$base#$n" else base) to b
        }
    }
    val footerCount = 1
    val lastIndex = keyed.size + footerCount - 1

    // Follow the reply while it streams, unless the user scrolled up to read.
    val streamTick = (chat.blocks.lastOrNull() as? Block.Assistant)?.let { it.text.length + (it.reasoning?.length ?: 0) } ?: 0
    LaunchedEffect(keyed.size, streamTick, chat.error) {
        if (keyed.isEmpty()) return@LaunchedEffect
        val info = list.layoutInfo
        val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
        val nearBottom = lastVisible >= info.totalItemsCount - 3
        // totalItemsCount is 0 on the first frame: start at the bottom.
        if (nearBottom || info.totalItemsCount == 0) list.scrollToItem(lastIndex)
    }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text(chat.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Icon(Icons.Filled.Computer, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(12.dp))
                            Text(
                                chat.subtitle,
                                style = MaterialTheme.typography.bodySmall,
                                color = p.inkFaint,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()).imePadding()) {
            Box(Modifier.weight(1f)) {
                when {
                    !chat.ready -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                    keyed.isEmpty() && chat.error == null -> Text(
                        "Ask your computer to do something. It can use its folders, tools and models.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = p.inkSoft,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(horizontal = 24.dp, vertical = 32.dp),
                    )
                    else -> LazyColumn(
                        state = list,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        itemsIndexed(keyed, key = { _, (k, _) -> k }) { _, (_, block) -> BlockView(block) }
                        item(key = "footer") {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                chat.error?.let { Notice(it, Tone.DANGER) }
                                val rate = chat.rate
                                if (!chat.running && rate != null) {
                                    Text(
                                        String.format(Locale.US, "%.1f tokens/s", rate),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = p.inkFaint,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            chat.approval?.let { ApprovalCard(it, onDecide = vm::approve) }
            chat.question?.let { QuestionCard(it, onAnswer = vm::answer) }
            Composer(
                running = chat.running,
                blocked = chat.blocked,
                queued = chat.queued,
                onSend = vm::send,
                onStop = vm::stop,
                modifier = Modifier.navigationBarsPadding(),
            )
        }
    }
}
