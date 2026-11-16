package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * One step of the agent's plan (`agentPlan`, written with `update_plan`), as the desktop's plan
 * sheet draws it (packages/shared/src/training.ts `PlanStep`; the iPhone's Plan.swift, #2115).
 */
data class PlanStep(
    val id: String,
    val title: String,
    val status: Status,
    val kind: Kind? = null,
    /** From 2 when a finished step was set active again (Verify sent the work back). */
    val pass: Int? = null,
    val verification: Verification? = null,
    val note: String? = null,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
) {
    enum class Status(val wire: String) { PENDING("pending"), ACTIVE("active"), DONE("done"), SKIPPED("skipped") }

    /** The step's place in the work loop, when the agent says. */
    enum class Kind(val wire: String, val label: String) { EXPLORE("explore", "Explore"), BUILD("build", "Build"), VERIFY("verify", "Verify"), SHIP("ship", "Ship") }

    /** The agent's explicit check of a step; a done step or a tool success is not one. */
    data class Verification(val status: Status, val device: String? = null, val detail: String? = null, val evidenceUrl: String? = null) {
        enum class Status(val wire: String) { PENDING("pending"), ACTIVE("active"), PASSED("passed"), FAILED("failed"), BLOCKED("blocked"), UNKNOWN("unknown") }

        /** The chip's words, the desktop's (`VerificationChip`): "Verified on macOS". */
        val label: String get() {
            val word = when (status) {
                Status.PENDING -> "Check pending"
                Status.ACTIVE -> "Checking"
                Status.PASSED -> "Verified"
                Status.FAILED -> "Check failed"
                Status.BLOCKED -> "Check blocked"
                Status.UNKNOWN -> "Check unknown"
            }
            return device?.let { "$word on $it" } ?: word
        }

        /** The evidence link, only when it is an http(s) URL. */
        val safeEvidence: String? get() = evidenceUrl?.takeIf { u ->
            val scheme = u.substringBefore("://", "").lowercase()
            (scheme == "http" || scheme == "https") && u.length > scheme.length + 3
        }
    }

    /** Finished and skipped steps squeeze to their title. */
    val squeezed: Boolean get() = status == Status.DONE || status == Status.SKIPPED

    /** The detail row: the check's own words, else the agent's note. */
    val detail: String? get() = listOfNotNull(verification?.detail, note).firstOrNull { it.isNotEmpty() }

    companion object {
        fun from(e: JsonElement?): PlanStep? {
            val o = e.obj() ?: return null
            val verification = o["verification"].obj()?.let { r ->
                r.str("status")?.let { s ->
                    Verification(Verification.Status.entries.firstOrNull { it.wire == s } ?: Verification.Status.UNKNOWN, r.str("device"), r.str("detail"), r.str("evidenceUrl"))
                }
            }
            return PlanStep(
                id = o.str("id") ?: return null,
                title = o.str("title") ?: return null,
                status = Status.entries.firstOrNull { it.wire == o.str("status") } ?: Status.PENDING,
                kind = Kind.entries.firstOrNull { it.wire == o.str("kind") },
                pass = o.long("pass")?.toInt(),
                verification = verification,
                note = o.str("note"),
                createdAt = o.long("createdAt") ?: 0,
                updatedAt = o.long("updatedAt") ?: 0,
            )
        }

        fun list(e: JsonElement?): List<PlanStep> = e.arr()?.mapNotNull(::from) ?: emptyList()
    }
}

/** A task in a project-management tool that the chat linked to. */
data class ProjectLink(val url: String, /** The task's own key where it has one ("NEK-412", "o/r#12"), else what it is. */ val label: String)

/** What one plan step produced, placed by the app rather than reported by the model. */
data class PlanStepLinks(
    val prs: List<String> = emptyList(),
    val projects: List<ProjectLink> = emptyList(),
    /** Sub-agent chats started while the step was being worked. */
    val subagents: List<String> = emptyList(),
) {
    val isEmpty: Boolean get() = prs.isEmpty() && projects.isEmpty() && subagents.isEmpty()
}

/**
 * The plan sheet's logic, ported from the desktop (`claudeAgentPlan.ts`, `planStepLinks.ts`,
 * `PlanSheet.tsx`) by way of the iPhone's AgentPlan, so the phones draw the same plan.
 */
object AgentPlan {
    /** Claude Code's provider kind (`CLAUDE_CODE_PROVIDER_KIND`). */
    const val CLAUDE_CODE_KIND = "claude-code"

    /**
     * The chat's own plan; on a Claude Agent chat without one, Claude Code's plan rebuilt from the
     * transcript. When Claude Code wrote no plan there is none: nothing is made up from its tool calls.
     */
    fun sheet(session: Session?, claudeCode: Boolean): List<PlanStep>? {
        session ?: return null
        if (session.agentPlan.isNotEmpty()) return session.agentPlan
        if (!claudeCode) return null
        return claudeCodeOwnPlan(session.messages)
    }

    /** The step being worked: the active one, else the next pending one, else the last. */
    fun current(plan: List<PlanStep>): PlanStep? =
        plan.firstOrNull { it.status == PlanStep.Status.ACTIVE } ?: plan.firstOrNull { it.status == PlanStep.Status.PENDING } ?: plan.lastOrNull()

    /** Finished (done or skipped) steps, for "1 of 4 done". */
    fun finished(plan: List<PlanStep>): Int = plan.count { it.squeezed }

    /** The open plan's one finished step that starts open: the last one with results (a PR, or a check's evidence). */
    fun openByDefault(plan: List<PlanStep>, links: Map<String, PlanStepLinks>): String? =
        plan.lastOrNull { it.squeezed && (links[it.id]?.prs?.isNotEmpty() == true || it.verification?.safeEvidence != null) }?.id

    /** The last reply was stopped and nothing runs: the active step shows paused. */
    fun paused(messages: List<ChatMessage>, running: Boolean): Boolean =
        !running && messages.lastOrNull { it.role == "assistant" }?.interrupted == true

    // Claude Code

    private fun firstLine(text: String) = text.split('\n').map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: ""

    private val TASK_CREATED = Regex("""Task #(\S+) created""")
    private fun taskId(output: String): String? = TASK_CREATED.find(output)?.groupValues?.get(1)

    private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun taskRef(v: JsonElement?): String =
        ((v as? JsonPrimitive)?.let { p -> if (p.isString) p.content else p.longOrNull?.toString() } ?: "").trim()

    /** Claude Code's own plan, rebuilt from its successful `TodoWrite` and `TaskCreate`/`TaskUpdate` calls. */
    fun claudeCodeOwnPlan(messages: List<ChatMessage>): List<PlanStep>? {
        val calls = HashMap<String, ToolCall>()
        messages.forEach { m -> m.toolCalls.forEach { calls[it.id] = it } }
        fun status(s: String?) = when (s) { "completed" -> PlanStep.Status.DONE; "in_progress" -> PlanStep.Status.ACTIVE; else -> PlanStep.Status.PENDING }
        var plan: List<PlanStep>? = null
        for (m in messages) {
            val r = m.toolResult ?: continue
            if (r.isError) continue
            val call = calls[r.toolCallId] ?: continue
            val input = call.input
            val at = m.createdAt ?: 0
            when (call.name) {
                "TodoWrite" -> {
                    val todos = input["todos"].arr().orEmpty().mapNotNull { t ->
                        val o = t.obj() ?: return@mapNotNull null
                        val c = o.str("content")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                        c to o.str("status")
                    }
                    if (todos.isNotEmpty()) plan = todos.mapIndexed { i, (c, s) -> PlanStep("todo_${i + 1}", c, status(s), createdAt = at, updatedAt = at) }
                }
                "TaskCreate" -> {
                    val subject = input["subject"].string()?.trim()?.takeIf { it.isNotEmpty() } ?: continue
                    val id = taskId(r.output) ?: continue
                    val note = firstLine(input["description"].string() ?: "")
                    plan = plan.orEmpty() + PlanStep("task_$id", subject, PlanStep.Status.PENDING, note = note.ifEmpty { null }, createdAt = at, updatedAt = at)
                }
                "TaskUpdate" -> {
                    val steps = plan ?: continue
                    val id = "task_${taskRef(input["taskId"])}"
                    if (input["status"].string() == "deleted") { plan = steps.filter { it.id != id }; continue }
                    plan = steps.map { s ->
                        if (s.id != id) s else s.copy(
                            status = input["status"].string()?.let(::status) ?: s.status,
                            title = input["subject"].string()?.trim()?.takeIf { it.isNotEmpty() } ?: s.title,
                            updatedAt = at,
                        )
                    }
                }
            }
        }
        return plan?.takeIf { it.isNotEmpty() }
    }

    // Chips placed on steps

    private val PROJECT_PATTERNS: List<Pair<Regex, (MatchResult) -> String>> = listOf(
        Regex("""^https://linear\.app/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\d+)""", RegexOption.IGNORE_CASE) to { m -> m.groupValues[1].uppercase() },
        Regex("""^https://[a-z0-9-]+\.atlassian\.net/browse/([A-Za-z][A-Za-z0-9]*-\d+)""", RegexOption.IGNORE_CASE) to { m -> m.groupValues[1].uppercase() },
        Regex("""^https://github\.com/([\w.-]+/[\w.-]+)/issues/(\d+)(?:[/?#]|$)""", RegexOption.IGNORE_CASE) to { m -> "${m.groupValues[1]}#${m.groupValues[2]}" },
        Regex("""^https://trello\.com/c/[A-Za-z0-9]+""", RegexOption.IGNORE_CASE) to { _ -> "Trello card" },
        Regex("""^https://app\.asana\.com/\d+/\d+/\d+""", RegexOption.IGNORE_CASE) to { _ -> "Asana task" },
        Regex("""^https://app\.clickup\.com/t/[\w-]+""", RegexOption.IGNORE_CASE) to { _ -> "ClickUp task" },
        Regex("""^https://(?:app\.)?todoist\.com/(?:app/)?(?:task|showTask)""", RegexOption.IGNORE_CASE) to { _ -> "Todoist task" },
    )
    private val URL = Regex("""https://[^\s<>()\[\]"'`]+""")
    private val TRAILING = Regex("""[.,;:!?]+$""")
    private val PR = Regex("""https?://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+""")

    /** Task links (Linear, Jira, GitHub issues, Trello, Asana, ClickUp, Todoist) in a message's text. */
    fun projectLinks(text: String): List<ProjectLink> {
        val found = ArrayList<ProjectLink>()
        for (raw in URL.findAll(text).map { it.value }) {
            val url = raw.replace(TRAILING, "")
            for ((pattern, label) in PROJECT_PATTERNS) {
                val m = pattern.find(url) ?: continue
                if (found.none { it.url == url }) found += ProjectLink(url, label(m))
                break
            }
        }
        return found
    }

    /** GitHub pull request URLs in a tool's output. */
    fun prUrls(text: String): List<String> = PR.findAll(text).map { it.value }.distinct().toList()

    /** The steps an `update_plan` call leaves, replayed only far enough to know titles and the active one. */
    internal fun replay(current: List<PlanStep>?, input: JsonObject): List<PlanStep>? {
        val raw = input["steps"].arr().orEmpty()
        if (raw.isEmpty()) return null
        val hadPlan = !current.isNullOrEmpty()
        val replace = (input["replace"] as? JsonPrimitive)?.booleanOrNull == true || !hadPlan
        val next = current.orEmpty().filter { !replace || it.squeezed }.toMutableList()
        for (r in raw) {
            val o = r.obj() ?: continue
            val title = (o.str("title") ?: "").trim().take(160)
            val id = o.str("id")?.trim() ?: ""
            val status = PlanStep.Status.entries.firstOrNull { it.wire == o.str("status") }
            var at: Int? = if (id.isEmpty()) null else next.indexOfFirst { it.id == id }.takeIf { it >= 0 }
            if (replace && at != null && title.isNotEmpty() && !next[at].title.equals(title, ignoreCase = true)) at = null
            if (at == null && title.isNotEmpty()) at = next.indexOfFirst { it.title.equals(title, ignoreCase = true) }.takeIf { it >= 0 }
            if (at != null) {
                val was = next[at].status
                var s = next[at]
                if (title.isNotEmpty()) s = s.copy(title = title)
                if (status != null && !(replace && (was == PlanStep.Status.DONE || was == PlanStep.Status.SKIPPED))) s = s.copy(status = status)
                next[at] = s
            } else if (title.isNotEmpty()) {
                next += PlanStep(if (id.isNotEmpty() && next.none { it.id == id }) id else "step_${next.size + 1}", title, status ?: PlanStep.Status.PENDING)
            }
        }
        return next.ifEmpty { null }
    }

    /**
     * What each step produced, worked out from the transcript as the desktop does: plan calls are
     * replayed in order, and a PR the agent opened belongs to the step active then (matched to the
     * live plan by title). Task links and sub-agents follow the same clock; anything before the
     * first step goes on the first step. [prs] are the chat's own PRs (`pr:sessionList`).
     */
    fun links(messages: List<ChatMessage>, plan: List<PlanStep>, prs: Set<String>, children: List<SessionSummary> = emptyList()): Map<String, PlanStepLinks> {
        val links = LinkedHashMap<String, PlanStepLinks>()
        val first = plan.firstOrNull() ?: return links
        fun key(t: String) = t.trim().lowercase()
        val byTitle = HashMap<String, String>()
        plan.forEach { byTitle.putIfAbsent(key(it.title), it.id) }
        var replayed: List<PlanStep>? = null
        var active: String? = null
        val timeline = ArrayList<Pair<Long, String?>>()
        fun work(title: String?, at: Long) {
            active = title?.let { byTitle[key(it)] }
            timeline += at to active
        }
        val creating = HashMap<String, String>()
        val tasks = HashMap<String, String>()
        fun edit(id: String, change: (PlanStepLinks) -> PlanStepLinks) { links[id] = change(links[id] ?: PlanStepLinks()) }
        for (message in messages) {
            val at = message.createdAt ?: 0
            message.toolResult?.let { r -> if (!r.isError) creating[r.toolCallId]?.let { subject -> taskId(r.output)?.let { tasks[it] = subject } } }
            if (message.role == "user" || message.role == "assistant") {
                for (link in projectLinks(message.content)) {
                    if (links.values.none { link in it.projects }) edit(active ?: first.id) { it.copy(projects = it.projects + link) }
                }
            }
            for (call in message.toolCalls) {
                when (call.name) {
                    "TodoWrite" -> work(call.input["todos"].arr()?.mapNotNull { it.obj() }?.firstOrNull { it.str("status") == "in_progress" }?.str("content"), at)
                    "TaskCreate" -> call.input["subject"].string()?.let { creating[call.id] = it }
                    "TaskUpdate" -> if (call.input["status"].string() == "in_progress") work(tasks[taskRef(call.input["taskId"])], at)
                    "update_plan" -> {
                        val next = replay(replayed, call.input) ?: continue
                        replayed = next
                        // With parallel active steps, the latest one in the plan is the one being worked.
                        work(next.lastOrNull { it.status == PlanStep.Status.ACTIVE }?.title, at)
                    }
                }
            }
            val now = active
            val output = message.toolResult?.output
            if (now != null && output != null) {
                for (url in prUrls(output)) if (url in prs && links[now]?.prs?.contains(url) != true) edit(now) { it.copy(prs = it.prs + url) }
            }
        }
        for (child in children.sortedBy { it.createdAt ?: it.updatedAt }) {
            val born = child.createdAt ?: child.updatedAt
            // The step being worked when it started, or the last one worked before then.
            val step = timeline.lastOrNull { it.first <= born && it.second != null }?.second ?: first.id
            edit(step) { it.copy(subagents = it.subagents + child.id) }
        }
        return links.filterValues { !it.isEmpty }
    }
}
