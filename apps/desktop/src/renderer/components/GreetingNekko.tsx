import React from 'react';

/** Travis's website beta-card peek, with a fixed glance toward the greeting. */
export function GreetingNekko() {
  return (
    <svg className="greeting-nekko" viewBox="0 0 32 30" width="64" height="60" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
      <g data-nekko-look transform="translate(2 0)" fill="var(--ink)">
        <path d="M11 15H13V18H11Z M20 15H22V18H20Z" />
      </g>
      <path d="M15 20H17V21H15Z" fill="var(--accent)" />
      <path d="M0 25H32V30H0Z" fill="var(--surface)" />
      <path d="M0 25H32" stroke="var(--line)" strokeWidth="1" />
      <g data-part="peek-paws">
        <path d="M7 23H12V28H7Z M20 23H25V28H20Z" fill="var(--surface)" />
        <path d="M6 22H13V27H12V23H7V27H6Z M19 22H26V27H25V23H20V27H19Z" fill="var(--ink)" />
        <path d="M8.5 23H9V24.5H8.5Z M10 23H10.5V24.5H10Z M21.5 23H22V24.5H21.5Z M23 23H23.5V24.5H23Z" fill="var(--ink)" opacity="0.55" />
      </g>
    </svg>
  );
}
