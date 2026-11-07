#!/usr/bin/env python3
"""Headless resource parity checks for #2095; never starts a native app."""
import json
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
ANDROID = ROOT / "apps/android/app/src/main/res"
IOS = ROOT / "apps/ios/App"
ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AssertionError(f"Duplicate catalog key: {key}")
        result[key] = value
    return result


class PermissionParityTests(unittest.TestCase):
    def test_exact_gentleface_paths_and_native_template_metadata(self):
        desktop = (ROOT / "apps/desktop/src/renderer/gentleface-icons.tsx").read_text()
        for name in ("hand", "shield-check", "running"):
            with self.subTest(icon=name):
                body = json.loads(re.search(r'"' + name + r'": \{\s+line: (".*?"),\n', desktop)[1])
                expected = re.findall(r'<path d="([^"]+)"', body)
                imageset = IOS / f"Assets.xcassets/PermissionIcons/permission-{name}.imageset"
                svg = ET.parse(imageset / f"permission-{name}.svg").getroot()
                self.assertEqual(svg.get("viewBox"), "0 0 16 16")
                self.assertEqual([p.get("d") for p in svg], expected)
                metadata = json.loads((imageset / "Contents.json").read_text())
                self.assertTrue(metadata["properties"]["preserves-vector-representation"])
                self.assertEqual(metadata["properties"]["template-rendering-intent"], "template")
                vector = ET.parse(ANDROID / f"drawable/permission_{name.replace('-', '_')}.xml").getroot()
                self.assertEqual(vector.get(ANDROID_NS + "viewportWidth"), "16")
                self.assertEqual(vector.get(ANDROID_NS + "viewportHeight"), "16")
                self.assertEqual([p.get(ANDROID_NS + "pathData") for p in vector], expected)

    def test_license_notices_are_bundled_verbatim(self):
        license_text = (ROOT / "apps/desktop/src/renderer/assets/gentleface/LICENSE").read_text()
        self.assertEqual((IOS / "PermissionIcons-LICENSE.txt").read_text(), license_text)
        self.assertEqual((ANDROID / "raw/license_gentleface_mit.txt").read_text(), license_text)

    def test_changed_catalog_keys_are_unique_and_fall_back_to_english(self):
        catalog = json.loads((IOS / "Localizable.xcstrings").read_text(), object_pairs_hook=unique_keys)
        for label in ("Always ask", "Ask when it matters", "No restrictions"):
            self.assertEqual(catalog["strings"][label].get("localizations"), {})
        source = (IOS / "Platform/SimpleMode.swift").read_text()
        for label in ("Always ask", "Ask when it matters", "No restrictions"):
            self.assertIn(f'String(localized: "{label}")', source)

    def test_android_changed_copy_is_explicitly_english_only(self):
        resources = {}
        for path in (ANDROID / "values").glob("strings*.xml"):
            resources.update({el.get("name"): el for el in ET.parse(path).getroot() if el.tag == "string"})
        keys = [key for key in resources if key.startswith(("permission_", "no_restrictions_warning_", "settings_warn_no_restrictions"))]
        self.assertEqual(len(keys), 12)
        for key in keys:
            self.assertEqual(resources[key].get("translatable"), "false", key)
            self.assertNotRegex(resources[key].text, r"YOLO|Guardrails|Works on its own|Asks first")
            for locale in ANDROID.glob("values-*/strings*.xml"):
                self.assertNotIn(key, [el.get("name") for el in ET.parse(locale).getroot()])
        kotlin = "\n".join(p.read_text() for p in (ROOT / "apps/android/app/src/main/java").rglob("*.kt"))
        self.assertNotRegex(kotlin, r"R\.string\.(?:settings_mode_(?:ask|guardrails|yolo)|simple_asks_(?:first|matters|own)|yolo_warning_(?:title|text|recommend|turn_on)|settings_warn_yolo(?:_detail)?)\b")


if __name__ == "__main__":
    unittest.main()
