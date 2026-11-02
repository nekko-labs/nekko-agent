package com.nekko.android

import org.junit.Assert.assertEquals
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Every English string (res/values/strings*.xml) has all six of the desktop's other
 * languages with the same placeholders (scripts/translations.py check does the same).
 */
class TranslationsTest {
    private val res = File("src/main/res")
    private val langs = listOf("de", "es", "fr", "ja", "pt", "b+zh+Hans")
    private val placeholder = Regex("""%(?:(\d+)\$)?([sd])""")

    private fun strings(file: File): Map<String, String> {
        if (!file.exists()) return emptyMap()
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = doc.documentElement.getElementsByTagName("string")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .filter { it.getAttribute("translatable") != "false" }
            .associate { it.getAttribute("name") to it.textContent }
    }

    private fun kinds(text: String) = placeholder.findAll(text).mapIndexed { i, m -> (m.groupValues[1].toIntOrNull() ?: (i + 1)) to m.groupValues[2] }.sortedBy { it.first }.toList()

    @Test fun `every string is in every language with the same placeholders`() {
        val english = res.resolve("values").listFiles { f -> f.name.startsWith("strings") && f.name.endsWith(".xml") }!!.sortedBy { it.name }
        val problems = mutableListOf<String>()
        var count = 0
        for (file in english) {
            val base = strings(file)
            count += base.size
            for (lang in langs) {
                val local = strings(res.resolve("values-$lang/${file.name}"))
                for ((name, text) in base) {
                    val t = local[name]
                    when {
                        t == null -> problems += "$lang/${file.name}: no $name"
                        kinds(t) != kinds(text) -> problems += "$lang/${file.name}: $name has other placeholders"
                    }
                }
                (local.keys - base.keys).forEach { problems += "$lang/${file.name}: $it no longer in English" }
            }
        }
        assertEquals(problems.joinToString("\n"), emptyList<String>(), problems)
        assert(count > 0)
    }
}
