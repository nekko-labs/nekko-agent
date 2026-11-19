//! SVG an agent's tool brings in (a cloud vector picture), made safe before it
//! is saved, shown or sent anywhere (spec/agents/media-tools-for-chat-agents.md,
//! "SVG is code"): parsed as XML with no DTD, and written back with only what
//! draws. Gone: `<script>`, `<foreignObject>` and other embedding elements,
//! every `on*` handler, links that are not to the same document, embedded
//! files, and `<style>` or `style` that load anything from outside. Then a PNG
//! preview for the chat and for models that read pictures, not SVG.

use roxmltree::{Document, Node, NodeType, ParsingOptions};

/// Elements dropped with everything inside them.
const DROPPED: [&str; 10] =
    ["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "handler", "listener", "image"];

/// A sanitized copy of `svg`, or why it is not an SVG Nekko will keep.
pub fn sanitize(svg: &str) -> Result<String, String> {
    let options = ParsingOptions { allow_dtd: false, ..ParsingOptions::default() };
    let doc = Document::parse_with_options(svg, options).map_err(|e| format!("not a valid SVG: {e}"))?;
    let root = doc.root_element();
    if !root.tag_name().name().eq_ignore_ascii_case("svg") {
        return Err("not an SVG document".into());
    }
    let mut out = String::with_capacity(svg.len());
    write(root, &mut out, true);
    Ok(out)
}

fn escape(s: &str, attr: bool) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' if attr => o.push_str("&quot;"),
            _ => o.push(c),
        }
    }
    o
}

/// A `url(...)`, `@import` or link to anything but this document.
fn loads_outside(value: &str) -> bool {
    let v = value.to_ascii_lowercase().replace(char::is_whitespace, "");
    if v.contains("@import") || v.contains("javascript:") || v.contains("expression(") {
        return true;
    }
    v.match_indices("url(").any(|(i, _)| {
        let rest = v[i + 4..].trim_start_matches(['\'', '"']);
        !rest.starts_with('#')
    })
}

fn safe_attribute(name: &str, value: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("on") {
        return false;
    }
    if lower == "href" || lower.ends_with(":href") || lower == "src" {
        // Only a link within this document (`#id`).
        return value.trim().starts_with('#');
    }
    !loads_outside(value)
}

fn write(node: Node, out: &mut String, top: bool) {
    match node.node_type() {
        NodeType::Element => {
            let tag = node.tag_name();
            let name = tag.name();
            let lower = name.to_ascii_lowercase();
            if DROPPED.contains(&lower.as_str()) {
                return;
            }
            // Animation that would set a link or a handler.
            if matches!(lower.as_str(), "set" | "animate")
                && node
                    .attributes()
                    .any(|a| a.name().eq_ignore_ascii_case("attributename") && !safe_attribute(a.value(), "#"))
            {
                return;
            }
            if lower == "style" && node.text().is_some_and(loads_outside) {
                return;
            }
            out.push('<');
            out.push_str(name);
            if top {
                out.push_str(" xmlns=\"http://www.w3.org/2000/svg\"");
            }
            for a in node.attributes() {
                let n = match a.namespace() {
                    Some("http://www.w3.org/1999/xlink") => format!("xlink:{}", a.name()),
                    Some(_) => continue,
                    None => a.name().to_string(),
                };
                if n == "xmlns" || !safe_attribute(&n, a.value()) {
                    continue;
                }
                out.push_str(&format!(" {n}=\"{}\"", escape(a.value(), true)));
            }
            if top && node.attributes().any(|a| a.namespace() == Some("http://www.w3.org/1999/xlink")) {
                out.push_str(" xmlns:xlink=\"http://www.w3.org/1999/xlink\"");
            }
            let children: Vec<Node> = node.children().collect();
            if children.is_empty() {
                out.push_str("/>");
                return;
            }
            out.push('>');
            for c in children {
                write(c, out, false);
            }
            out.push_str(&format!("</{name}>"));
        }
        NodeType::Text => out.push_str(&escape(node.text().unwrap_or_default(), false)),
        _ => {}
    }
}

/// A PNG of a sanitized SVG, at most `max` pixels on its longer side.
pub fn preview_png(svg: &str, max: u32) -> Result<Vec<u8>, String> {
    use resvg::{tiny_skia, usvg};
    let tree =
        usvg::Tree::from_str(svg, &usvg::Options::default()).map_err(|e| format!("the SVG could not be drawn: {e}"))?;
    let size = tree.size();
    let scale = (max as f32 / size.width().max(size.height())).min(4.0);
    let (w, h) = ((size.width() * scale).ceil().max(1.0) as u32, (size.height() * scale).ceil().max(1.0) as u32);
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("the SVG has no size")?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    pixmap.encode_png().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_draws_is_kept() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><path d="M0 0L10 10" stroke="#000"/></svg>"##;
        let out = sanitize(svg).unwrap();
        assert!(out.contains(r##"fill="url(#g)""##), "{out}");
        assert!(out.contains(r##"<path d="M0 0L10 10" stroke="#000"/>"##), "{out}");
        assert!(out.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg""#), "{out}");
    }

    #[test]
    fn scripts_handlers_and_outside_links_are_gone() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
<script>alert(2)</script><foreignObject><div>x</div></foreignObject>
<a href="https://evil.example"><rect onclick="x()" width="1" height="1"/></a>
<use xlink:href="#ok"/><use href="https://evil.example/a.svg#x"/><image href="data:image/png;base64,AAAA"/>
<style>@import url(https://evil.example/a.css);</style><rect style="fill:url(https://evil.example/p)"/>
<set attributeName="href" to="javascript:alert(3)"/></svg>"##;
        let out = sanitize(svg).unwrap();
        for bad in
            ["alert", "script", "foreignObject", "evil.example", "onclick", "onload", "image", "@import", "javascript"]
        {
            assert!(!out.to_lowercase().contains(&bad.to_lowercase()), "{bad} survived: {out}");
        }
        assert!(out.contains(r##"xlink:href="#ok""##), "{out}");
    }

    #[test]
    fn a_dtd_or_something_else_is_refused() {
        let entity = r#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>"#;
        assert!(sanitize(entity).is_err());
        assert!(sanitize("<html/>").is_err());
        assert!(sanitize("not xml").is_err());
    }

    #[test]
    fn a_sanitized_svg_has_a_png_preview() {
        let svg = sanitize(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" width="20" height="10"><rect width="20" height="10" fill="#08f"/></svg>"##).unwrap();
        let png = preview_png(&svg, 200).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }
}
