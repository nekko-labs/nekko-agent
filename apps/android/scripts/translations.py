#!/usr/bin/env python3
"""The Android app's translations, kept in step with the iPhone's.

The app ships the desktop's languages (apps/desktop/src/renderer/i18n.ts):
English (values/), Español, Français, Deutsch, Português, 日本語 and 中文 (Simplified).
English strings live in app/src/main/res/values/strings*.xml; each language has the
same file under values-<lang>/.

  translations.py fill [values/strings_x.xml ...]
      For every English string, take the iPhone's translation of the same text
      (apps/ios/App/Localizable.xcstrings, placeholders matched by order) and write
      the language files. Strings the iPhone doesn't have, and translations already
      in a language file, are kept; the ones still missing are listed, to translate
      by hand in the language files.
  translations.py like <words>
      How the iPhone already translates texts with these words: use its terms
      (Spanish "computadora", French "discussion" for a chat, "du"/"tu" where it does).
  translations.py check
      Every English string has all six translations with the same placeholders.
      (TranslationsTest checks the same in the app's JVM tests.)

Run with `python3 -I`; it reads and writes only files in this repository.
"""
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
RES = os.path.join(ROOT, "apps", "android", "app", "src", "main", "res")
CATALOG = os.path.join(ROOT, "apps", "ios", "App", "Localizable.xcstrings")
# Android resource folder -> the iPhone catalog's language.
LANGS = {"de": "de", "es": "es", "fr": "fr", "ja": "ja", "pt": "pt", "b+zh+Hans": "zh-Hans"}

ANDROID_PH = re.compile(r"%(?:(\d+)\$)?([sd])")
IOS_PH = re.compile(r"%(?:(\d+)\$)?(@|lld|ld|d|li|lu|f|\.\d+f)")


def unescape(s):
    """An Android string resource's text as shown."""
    out, i = [], 0
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        s = s[1:-1]
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            out.append({"n": "\n", "t": "\t"}.get(n, n))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def escape(s):
    """Text as an Android string resource (XML escaping is ElementTree's)."""
    s = s.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"').replace("\n", "\\n")
    if s[:1] in ("@", "?"):
        s = "\\" + s
    return s


def android_placeholders(text):
    """Placeholder types by position: ['s', 'd']."""
    found = {}
    for n, (pos, kind) in enumerate(ANDROID_PH.findall(text)):
        found[int(pos) if pos else n + 1] = kind
    return [found[k] for k in sorted(found)]


def canon_android(text):
    """The text with its placeholders as {1}, {2}: comparable with the iPhone's keys."""
    counter = [0]

    def sub(m):
        counter[0] += 1
        return "{%s}" % (m.group(1) or counter[0])

    return ANDROID_PH.sub(sub, text.replace("%%", "%"))


def canon_ios(text):
    counter = [0]

    def sub(m):
        counter[0] += 1
        return "{%s}" % (m.group(1) or counter[0])

    return IOS_PH.sub(sub, text.replace("%%", "%"))


def to_android(translation, kinds):
    """An iPhone translation with Android placeholders (%1$s, %2$d) of the English string's kinds."""
    counter = [0]
    bad = [False]

    def sub(m):
        counter[0] += 1
        n = int(m.group(1) or counter[0])
        if n > len(kinds):
            bad[0] = True
            return m.group(0)
        return "%%%d$%s" % (n, kinds[n - 1])

    escaped = translation.replace("%%", "\0")
    out = IOS_PH.sub(sub, escaped)
    if kinds:
        # A lone % in a formatted string must be doubled; an escaped one already is.
        out = re.sub(r"%(?!\d+\$[sd])", "%%", out)
        out = out.replace("\0", "%%")
    else:
        out = out.replace("\0", "%")
    return None if bad[0] else out


def catalog():
    data = json.load(open(CATALOG, encoding="utf-8"))
    table = {}
    for key, entry in data["strings"].items():
        locs = entry.get("localizations", {})
        english = locs.get("en", {}).get("stringUnit", {}).get("value", key)
        values = {}
        for lang, loc in locs.items():
            unit = loc.get("stringUnit")
            if unit and unit.get("value"):
                values[lang] = unit["value"]
        table.setdefault(canon_ios(english), values)
        table.setdefault(canon_ios(key), values)
    return table


def strings(path):
    """name -> text of the <string> resources in a file (translatable ones only)."""
    if not os.path.exists(path):
        return {}
    out = {}
    for el in ET.parse(path).getroot():
        if el.tag == "string" and el.get("translatable") != "false":
            out[el.get("name")] = unescape("".join(el.itertext()))
    return out


def write(path, entries, header):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    root = ET.Element("resources")
    root.text = "\n"
    for name, text in entries:
        el = ET.SubElement(root, "string", name=name)
        el.text = escape(text)
        el.tail = "\n"
    if len(root):
        root[-1].tail = "\n"
    body = ET.tostring(root, encoding="unicode")
    body = body.replace("<resources>", "<resources>\n", 1).replace("\n<string", "\n    <string")
    with open(path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n')
        f.write(header)
        f.write(body.replace("<resources>\n\n", "<resources>\n"))
        f.write("\n")


def english_files(args):
    if args:
        return [os.path.abspath(a) if os.path.exists(a) else os.path.join(RES, "values", os.path.basename(a)) for a in args]
    folder = os.path.join(RES, "values")
    return sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.startswith("strings") and f.endswith(".xml"))


def fill(args):
    table = catalog()
    missing = 0
    for path in english_files(args):
        english = strings(path)
        name = os.path.basename(path)
        for folder, ios in LANGS.items():
            target = os.path.join(RES, "values-" + folder, name)
            have = strings(target)
            entries = []
            for key, text in english.items():
                kinds = android_placeholders(text)
                value = have.get(key)
                if value is None:
                    found = table.get(canon_android(text), {}).get(ios)
                    value = to_android(found, kinds) if found else None
                if value is None:
                    missing += 1
                    print(f"missing {folder}/{name}: {key} = {text!r}")
                    continue
                entries.append((key, value))
            write(target, entries, "<!-- Translated from values/%s (scripts/translations.py fill). -->\n" % name)
    print(f"{missing} translations to write by hand" if missing else "every string is translated")


def check(_args):
    problems = 0
    for path in english_files([]):
        name = os.path.basename(path)
        for key, text in strings(path).items():
            kinds = sorted(android_placeholders(text))
            for folder in LANGS:
                value = strings(os.path.join(RES, "values-" + folder, name)).get(key)
                if value is None:
                    problems += 1
                    print(f"{folder}/{name}: no {key}")
                elif kinds and re.search(r"(?<!%)%(?!%|\d+\$[sd])|%%%", value):
                    problems += 1
                    print(f"{folder}/{name}: {key} has a stray %: {value!r}")
                elif sorted(android_placeholders(value)) != kinds:
                    problems += 1
                    print(f"{folder}/{name}: {key} has other placeholders: {value!r}")
    print(f"{problems} problems" if problems else "ok")
    return 1 if problems else 0


def like(args):
    words = " ".join(args).lower()
    data = json.load(open(CATALOG, encoding="utf-8"))
    shown = 0
    for key, entry in data["strings"].items():
        if words in key.lower():
            locs = entry.get("localizations", {})
            print(key)
            for lang in LANGS.values():
                value = locs.get(lang, {}).get("stringUnit", {}).get("value")
                if value:
                    print(f"  {lang}: {value}")
            shown += 1
            if shown >= 12:
                break


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    sys.exit({"fill": fill, "check": check, "like": like}[command](sys.argv[2:]) or 0)
