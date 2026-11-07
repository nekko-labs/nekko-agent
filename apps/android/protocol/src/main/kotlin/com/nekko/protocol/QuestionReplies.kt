package com.nekko.protocol

/** Display-only projection after saved/live reconciliation: never a new prompt
 * in model history, and never an anchor that splits the running turn. */
object QuestionReplies {
    private const val PREFIX = "The user answered:\n\n"
    private const val SUFFIX = "\n\nWork to these answers. Do not ask again about anything settled here."
    fun body(name: String, output: String?): String? {
        if (name != "ask_user" || output == null || !output.startsWith(PREFIX) || !output.endsWith(SUFFIX)) return null
        val body = output.removePrefix(PREFIX).removeSuffix(SUFFIX)
        return body.takeIf { it.startsWith("Q: ") && it.contains("\nA: ") }
    }

    fun project(blocks: List<Block>): List<Block> = buildList {
        val seen = mutableSetOf<String>()
        for (block in blocks) {
            add(block)
            if (block is Block.Tool && block.status == ToolStatus.OK && seen.add(block.id)) {
                body(block.name, block.output)?.let { add(Block.User("ask-answer:${block.id}", it)) }
            }
        }
    }
}
