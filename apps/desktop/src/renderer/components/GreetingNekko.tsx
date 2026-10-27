import React, { useEffect, useRef, useState } from 'react';

/** A bounded glance keeps both pixel eyes inside the face. */
export function greetingGaze(dx: number, dy: number) {
  const distance = Math.hypot(dx, dy);
  const scale = distance ? Math.min(1, distance / 120) / distance : 0;
  return { x: Math.round(dx * scale * 2 * 10) / 10, y: Math.round(dy * scale * 2 * 10) / 10 };
}

/** Decorative greeting cat; gaze follows the text caret in this composer section. */
export function GreetingNekko() {
  const ref = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState({ x: 0, y: 1 });
  useEffect(() => {
    const svg = ref.current;
    const composer = svg?.closest('.composer-section');
    if (!svg || !composer) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selection = document.getSelection();
        const editor = composer.querySelector('[contenteditable]');
        if (!editor || !selection?.focusNode || !editor.contains(selection.focusNode) || !selection.rangeCount) return;
        const range = selection.getRangeAt(0).cloneRange();
        range.setStart(selection.focusNode, selection.focusOffset);
        range.collapse(true);
        const caret = range.getClientRects()[0] ?? editor.getBoundingClientRect();
        const face = svg.getBoundingClientRect();
        setLook(greetingGaze(caret.left - (face.left + face.width / 2), caret.top - (face.top + face.height / 2)));
      });
    };
    document.addEventListener('selectionchange', update);
    composer.addEventListener('input', update);
    composer.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      composer.removeEventListener('input', update);
      composer.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, []);
  return (
    <span className="greeting-nekko-slot" aria-hidden="true"><svg ref={ref} className="greeting-nekko" viewBox="0 0 32 30" width="80" height="75" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {/* Only the paws hang over the composer; the chin stays behind its edge. */}
      <svg data-part="peek-face" width="32" height="25" viewBox="0 0 32 25" overflow="hidden">
        <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
        <g data-nekko-look transform={`translate(${look.x} ${look.y})`} fill="var(--ink)">
          <path d="M11 15H13V18H11Z M20 15H22V18H20Z" />
        </g>
      </svg>
      <g data-part="peek-paws" transform="translate(0 50) scale(1 -1)">
        <path d="M6 24H11V28H6Z M21 24H26V28H21Z" fill="var(--surface)" />
        <path d="M5 23H12V27H11V24H6V27H5Z M20 23H27V27H26V24H21V27H20Z" fill="var(--ink)" />
        <path d="M7.5 24H8V25.5H7.5Z M9 24H9.5V25.5H9Z M22.5 24H23V25.5H22.5Z M24 24H24.5V25.5H24Z" fill="var(--ink)" opacity="0.55" />
      </g>
    </svg></span>
  );
}
