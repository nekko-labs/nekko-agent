package com.nekko.protocol

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * One transcript model for a computer chat: saved messages plus a live overlay
 * folded from `agent:event`s while a turn runs. A port of
 * `apps/mobile/src/lib/transcript.ts`; the UI renders [Block]s only.
 */
enum class ToolStatus { RUNNING, WAITING, OK, ERROR }

sealed interface Block {
    val id: String

    data class User(override val id: String, val text: String, val at: Long? = null, val images: Int = 0) : Block
    data class Assistant(
        override val id: String,
        val text: String,
        val reasoning: String? = null,
        val streaming: Boolean = false,
        val interrupted: Boolean = false,
    ) : Block
    data class Tool(
        override val id: String,
        val name: String,
        val label: String,
        val status: ToolStatus,
        val output: String? = null,
    ) : Block
}

/** What a running turn has produced so far, before the session is re-read. */
data class LiveTurn(
    val running: Boolean = false,
    val blocks: List<Block> = emptyList(),
    val approval: Approval? = null,
    val question: AskRequest? = null,
    val error: String? = null,
    /** Tokens/sec of the last reply, when the host reported usage. */
    val rate: Double? = null,
)

object Transcript {
    /** Saved messages → blocks. Tool results attach to the call that asked for them. */
    fun fromMessages(messages: List<ChatMessage>): List<Block> {
        val out = ArrayList<Block>()
        val toolIndex = HashMap<String, Int>()
        for (m in messages) {
            when (m.role) {
                "user" -> out += Block.User(
                    m.id,
                    m.skill?.let { (name, input) -> "/$name $input".trim() } ?: m.content,
                    m.createdAt,
                    m.imageCount,
                )
                "assistant" -> {
                    if (m.content.isNotBlank() || !m.reasoning.isNullOrBlank()) {
                        out += Block.Assistant(m.id, m.content, m.reasoning?.ifEmpty { null }, interrupted = m.interrupted)
                    }
                    for (call in m.toolCalls) {
                        toolIndex[call.id] = out.size
                        out += Block.Tool(call.id, call.name, toolLabel(call), ToolStatus.OK)
                    }
                }
                "tool" -> {
                    val r = m.toolResult ?: continue
                    val i = toolIndex[r.toolCallId] ?: continue
                    val b = out[i] as Block.Tool
                    out[i] = b.copy(status = if (r.isError) ToolStatus.ERROR else ToolStatus.OK, output = clip(r.output))
                }
            }
        }
        return out
    }

    /** Fold one agent event into the live turn. Pure. */
    fun apply(turn: LiveTurn, e: AgentEvent): LiveTurn = when (e) {
        is AgentEvent.Text -> appendStream(turn) { it.copy(text = it.text + e.delta) }
        is AgentEvent.Reasoning -> appendStream(turn) { it.copy(reasoning = (it.reasoning ?: "") + e.delta) }
        is AgentEvent.ToolCallStarted -> turn.copy(
            running = true,
            blocks = settle(turn.blocks) + Block.Tool(e.call.id, e.call.name, toolLabel(e.call), ToolStatus.RUNNING),
        )
        is AgentEvent.ApprovalRequired -> turn.copy(
            running = true,
            approval = e.approval,
            blocks = upsertTool(turn.blocks, e.approval.call, ToolStatus.WAITING),
        )
        is AgentEvent.ToolResultReady -> turn.copy(
            approval = if (turn.approval?.call?.id == e.result.toolCallId) null else turn.approval,
            blocks = turn.blocks.map { b ->
                if (b is Block.Tool && b.id == e.result.toolCallId) {
                    b.copy(status = if (e.result.isError) ToolStatus.ERROR else ToolStatus.OK, output = clip(e.result.output))
                } else b
            },
        )
        is AgentEvent.Question -> turn.copy(running = true, question = e.request)
        is AgentEvent.QuestionResolved -> if (turn.question?.callId == e.callId) turn.copy(question = null) else turn
        is AgentEvent.Usage -> if ((e.outputMs ?: 0) > 0 && e.outputTokens > 0) {
            turn.copy(rate = e.outputTokens.toDouble() / e.outputMs!! * 1000)
        } else turn
        is AgentEvent.Retry -> {
            // The failed call's streamed text is regenerated: drop what came after the last tool.
            turn.copy(blocks = turn.blocks.take(turn.blocks.indexOfLast { it !is Block.Assistant } + 1))
        }
        is AgentEvent.Done -> turn.copy(running = false, approval = null, question = null, blocks = settle(turn.blocks))
        is AgentEvent.Error -> turn.copy(
            running = false,
            approval = null,
            question = null,
            blocks = settle(turn.blocks),
            // A user stop arrives as an error; it isn't one from the user's side.
            error = if (Regex("^(stopped|aborted)$", RegexOption.IGNORE_CASE).matches(e.message)) null else e.message,
        )
        is AgentEvent.SessionMeta, is AgentEvent.Other -> turn
    }

    private fun appendStream(turn: LiveTurn, change: (Block.Assistant) -> Block.Assistant): LiveTurn {
        val blocks = turn.blocks.toMutableList()
        val last = blocks.lastOrNull() as? Block.Assistant
            ?: Block.Assistant("live-${blocks.size}", "", streaming = true).also { blocks += it }
        blocks[blocks.size - 1] = change(last).copy(streaming = true)
        return turn.copy(running = true, blocks = blocks)
    }

    private fun settle(blocks: List<Block>) = blocks.map { if (it is Block.Assistant && it.streaming) it.copy(streaming = false) else it }

    private fun upsertTool(blocks: List<Block>, call: ToolCall, status: ToolStatus): List<Block> =
        if (blocks.any { it is Block.Tool && it.id == call.id }) {
            blocks.map { if (it is Block.Tool && it.id == call.id) it.copy(status = status) else it }
        } else {
            settle(blocks) + Block.Tool(call.id, call.name, toolLabel(call), status)
        }

    /**
     * Saved transcript + live overlay without duplicates. Only this turn's saved
     * blocks (after our prompt) count, so a reply or call id that repeats an
     * earlier turn is never swallowed.
     */
    fun mergeLive(saved: List<Block>, live: List<Block>): List<Block> {
        if (live.isEmpty()) return saved
        val prompt = live.firstOrNull { it is Block.User } as Block.User?
        val lastUserAt = saved.indexOfLast { it is Block.User }
        val lastUser = saved.getOrNull(lastUserAt) as Block.User?
        if (prompt != null && lastUser?.text?.trim() != prompt.text.trim()) return saved + live
        val head = saved.take(lastUserAt + 1)
        val turn = saved.drop(lastUserAt + 1)
        val toolIds = turn.filterIsInstance<Block.Tool>().map { it.id }.toSet()
        val replies = turn.filterIsInstance<Block.Assistant>().map { it.text.trim() }
        val liveTools = live.filterIsInstance<Block.Tool>().associateBy { it.id }
        val extra = live.filter { b ->
            when (b) {
                is Block.User -> false
                is Block.Tool -> b.id !in toolIds
                is Block.Assistant -> b.text.isBlank() || b.text.trim() !in replies
            }
        }
        return head + turn.map { if (it is Block.Tool && it.id in liveTools) liveTools.getValue(it.id) else it } + extra
    }

    /** Short human label for a tool call: the file, command or query it acts on. */
    fun toolLabel(call: ToolCall): String {
        val detail = listOf("command", "path", "file_path", "pattern", "query", "url", "name", "prompt", "task")
            .firstNotNullOfOrNull { k -> (call.input[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim()?.ifEmpty { null } }
        val verb = TOOL_VERBS[call.name] ?: call.name.replace('_', ' ')
        return if (detail != null) "$verb ${oneLine(detail, 80)}" else verb
    }

    private val TOOL_VERBS = mapOf(
        "read_file" to "Read", "write_file" to "Write", "edit_file" to "Edit", "list_dir" to "List",
        "glob" to "Find", "grep" to "Search", "bash" to "Run", "web_fetch" to "Fetch",
        "web_search" to "Search the web for", "spawn_agent" to "Delegate", "ask_user" to "Ask",
    )

    private fun oneLine(s: String, max: Int): String {
        val flat = s.replace(Regex("\\s+"), " ").trim()
        return if (flat.length > max) flat.take(max - 1) + "…" else flat
    }

    fun clip(s: String, max: Int = 4000): String =
        if (s.length > max) "${s.take(max)}\n… (${s.length - max} more characters)" else s
}

/** What the chat list shows next to a computer's chat. */
enum class Activity { RUNNING, NEEDS_YOU }

object ActivityTracker {
    /** Track which chats are mid-run or waiting on the user, from the event stream. */
    fun next(activity: Map<String, Activity>, e: AgentEvent): Map<String, Activity> {
        val cur = activity[e.sessionId]
        val next: Activity? = when (e) {
            is AgentEvent.ApprovalRequired, is AgentEvent.Question -> Activity.NEEDS_YOU
            is AgentEvent.Text, is AgentEvent.Reasoning, is AgentEvent.ToolCallStarted,
            is AgentEvent.ToolResultReady, is AgentEvent.QuestionResolved -> Activity.RUNNING
            is AgentEvent.Done, is AgentEvent.Error -> null
            else -> return activity
        }
        if (next == cur) return activity
        return if (next == null) activity - e.sessionId else activity + (e.sessionId to next)
    }
}
