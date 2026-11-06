import React from 'react';

/** The plan's ripple indicator. Color follows the theme; reduced motion keeps a still ring. */
export function PlanWorking() {
  return <span className="plan-working" aria-hidden="true">
    <svg className="plan-working-motion" width="16" height="16" viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg" stroke="currentColor">
      <g fill="none" fillRule="evenodd" transform="translate(1 1)" strokeWidth="2">
        {['1.5s', '3s'].map(begin => <circle key={begin} cx="22" cy="22" r="6" strokeOpacity="0">
          <animate attributeName="r" begin={begin} dur="3s" values="6;22" calcMode="linear" repeatCount="indefinite" />
          <animate attributeName="stroke-opacity" begin={begin} dur="3s" values="1;0" calcMode="linear" repeatCount="indefinite" />
          <animate attributeName="stroke-width" begin={begin} dur="3s" values="2;0" calcMode="linear" repeatCount="indefinite" />
        </circle>)}
        <circle cx="22" cy="22" r="8">
          <animate attributeName="r" begin="0s" dur="1.5s" values="6;1;2;3;4;5;6" calcMode="linear" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
    <svg className="plan-working-still" width="16" height="16" viewBox="0 0 45 45" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="22" cy="22" r="16" /><circle cx="22" cy="22" r="6" /></svg>
  </span>;
}
