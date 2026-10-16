import React, { useLayoutEffect, useRef, useState } from 'react';
import { railGeometry } from '../railGeometry.js';

/** Mount directly inside .rail-group. Observe layout owners, never a frame loop
 * or the animated rail width. The SVG is decoration and cannot intercept input. */
export function RailBackdrop() {
  const ref = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState(() => railGeometry({ railHeight: 0, groupTop: 0, groupHeight: 0 }));
  useLayoutEffect(() => {
    const group = ref.current?.parentElement;
    const rail = group?.parentElement;
    const parent = rail?.parentElement;
    if (!group || !rail || !parent) return;
    const measure = () => {
      const railBox = rail.getBoundingClientRect();
      const groupBox = group.getBoundingClientRect();
      // Let the decorative tip reach into the header, beside its mascot.
      const headerClearance = Math.min(58, Math.max(0, railBox.top));
      const next = railGeometry({ railHeight: railBox.height + headerClearance, groupTop: groupBox.top - railBox.top + headerClearance, groupHeight: groupBox.height });
      setGeometry(previous => previous.polygon === next.polygon && previous.height === next.height ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    // Block-size-only observation avoids recalculation during width animation.
    let groupHeight = group.getBoundingClientRect().height;
    const groupObserver = new ResizeObserver(() => {
      const next = group.getBoundingClientRect().height;
      if (next !== groupHeight) { groupHeight = next; measure(); }
    });
    groupObserver.observe(group);
    return () => { observer.disconnect(); groupObserver.disconnect(); };
  }, []);
  return <svg ref={ref} className="rail-backdrop" aria-hidden="true" focusable="false"
    viewBox={`0 0 ${geometry.width} ${geometry.height || 1}`} preserveAspectRatio="none"
    style={{ top: -geometry.top, height: geometry.height }}>
    <polygon points={geometry.polygon} />
  </svg>;
}
