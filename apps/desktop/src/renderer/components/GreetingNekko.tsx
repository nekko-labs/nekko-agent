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
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
      <g data-nekko-look transform={`translate(${look.x} ${look.y})`} fill="var(--ink)">
        <path d="M11 15H13V18H11Z M20 15H22V18H20Z" />
      </g>
      <g data-part="peek-paws">
        <path d="M7 23H12V28H7Z M20 23H25V28H20Z" fill="var(--surface)" />
        <path d="M6 22H13V27H12V23H7V27H6Z M19 22H26V27H25V23H20V27H19Z" fill="var(--ink)" />
        <path d="M8.5 23H9V24.5H8.5Z M10 23H10.5V24.5H10Z M21.5 23H22V24.5H21.5Z M23 23H23.5V24.5H23Z" fill="var(--ink)" opacity="0.55" />
      </g>
    </svg></span>
  );
}
