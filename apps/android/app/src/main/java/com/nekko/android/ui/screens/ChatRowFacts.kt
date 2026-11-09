package com.nekko.android.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ChatCard
import com.nekko.protocol.PullRequest

/** A provider mark's drawable (Lobe Icons, as the desktop's `public/providers`), or null for none. */
@DrawableRes
internal fun providerDrawable(mark: String?): Int? = when (mark) {
    "anthropic" -> R.drawable.provider_anthropic
    "openai" -> R.drawable.provider_openai
    "google" -> R.drawable.provider_google
    "openrouter" -> R.drawable.provider_openrouter
    "ollama" -> R.drawable.provider_ollama
    "lmstudio" -> R.drawable.provider_lmstudio
    "vllm" -> R.drawable.provider_vllm
    else -> null
}

/**
 * The model a chat runs on, as the desktop card's line: the provider's mark,
 * tinted like the words, then "Opus 5.5". No mark for a custom endpoint.
 * The iPhone's `ModelFact`.
 */
@Composable
internal fun ModelFact(model: String, mark: String?) {
    val p = Nekko.palette
    val name = ChatCard.modelName(model)
    val desc = stringResource(R.string.chats_row_model, name)
    Row(
        Modifier.testTag("chats.row.model").clearAndSetSemantics { contentDescription = desc },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        providerDrawable(mark)?.let {
            Icon(painterResource(it), contentDescription = null, tint = p.accent, modifier = Modifier.size(11.dp).testTag("chats.row.provider.$mark"))
        }
        Text(name, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium, color = p.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * How full the chat's context window is, `45k/1M`, in the hue of how close to
 * full it is (the desktop's `fillTone`: green, amber from 60%, red from 85%).
 */
@Composable
internal fun ContextFact(context: ChatCard.Context) {
    val p = Nekko.palette
    val tone = when (context.fill) {
        ChatCard.Fill.ROOM -> p.success
        ChatCard.Fill.FILLING -> p.warning
        ChatCard.Fill.FULL -> p.danger
    }
    val desc = stringResource(R.string.chats_row_context, context.percent)
    Text(
        context.text, style = MaterialTheme.typography.labelSmall, color = tone, maxLines = 1,
        modifier = Modifier.testTag("chats.row.context").clearAndSetSemantics { contentDescription = desc },
    )
}

@DrawableRes
private fun prGlyph(s: ChatCard.PrStatus?): Int = when (s) {
    ChatCard.PrStatus.DRAFT -> R.drawable.pr_draft
    ChatCard.PrStatus.MERGED -> R.drawable.pr_merged
    ChatCard.PrStatus.CLOSED -> R.drawable.pr_closed
    ChatCard.PrStatus.OPEN, null -> R.drawable.pr_open
}

/**
 * The PRs a chat made, as the desktop card's chip (`SessionPrChip`): the PR that
 * matters most with GitHub's glyph for its state, tinted as GitHub tints it, and
 * `+N` for the others. Until the computer has said what state they are in (or
 * while it can't be reached), the chip shows the chat's links untinted.
 * The iPhone's `RowPrChip`.
 */
@Composable
internal fun RowPrChip(prs: List<PullRequest>, urls: List<String>) {
    val p = Nekko.palette
    val pr = ChatCard.primaryPr(prs)
    val status = pr?.let(ChatCard::prStatus)
    val number = pr?.number ?: urls.lastOrNull()?.substringAfterLast('/')?.toIntOrNull() ?: return
    val count = if (pr != null) prs.size else urls.size
    val tone = when (status) {
        ChatCard.PrStatus.OPEN -> p.success
        ChatCard.PrStatus.DRAFT, null -> p.inkFaint
        ChatCard.PrStatus.MERGED -> p.accent
        ChatCard.PrStatus.CLOSED -> p.danger
    }
    val words = mapOf(
        ChatCard.PrStatus.OPEN to stringResource(R.string.chats_pr_open),
        ChatCard.PrStatus.DRAFT to stringResource(R.string.chats_pr_draft),
        ChatCard.PrStatus.MERGED to stringResource(R.string.chats_pr_merged),
        ChatCard.PrStatus.CLOSED to stringResource(R.string.chats_pr_closed),
    )
    val template = stringResource(R.string.chats_row_pr)
    val desc = if (prs.isNotEmpty()) {
        prs.joinToString(", ") { template.format(it.number, words.getValue(ChatCard.prStatus(it))) }
    } else {
        urls.joinToString(", ") { "#" + it.substringAfterLast('/') }
    }
    Row(
        Modifier
            .testTag("chats.row.prs")
            .clearAndSetSemantics { contentDescription = desc }
            .border(1.dp, p.line, CircleShape)
            .padding(horizontal = 6.dp, vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Icon(painterResource(prGlyph(status)), contentDescription = null, tint = tone, modifier = Modifier.size(11.dp))
            Text("#$number", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = tone)
        }
        if (count > 1) Text("+${count - 1}", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = p.inkFaint)
    }
}
