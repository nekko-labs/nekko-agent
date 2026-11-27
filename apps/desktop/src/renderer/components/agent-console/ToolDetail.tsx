import type { ToolCall, ToolResult } from '@nekko-agent/shared';
import { HighlightedCode } from '../HighlightedCode.js';

/** Render inside the same wrapping, scrollable pre for hover and disclosure. */
export function ToolDetail({ call, failed, result }: { call: ToolCall; failed?: boolean; result?: ToolResult }) {
  const shell = /^(?:functions\.)?(?:bash|start_process|powershell)$/i.test(call.name);
  const { command, ...options } = call.input;
  return <>
    {(failed || result?.isError) && <><strong className="text-danger-text">Failed</strong>{'\n'}{result?.output.trim() ? result.output : result?.deniedReason || 'No failure message was recorded.'}{'\n\n'}</>}
    {shell && typeof command === 'string' ? <><HighlightedCode language={/powershell$/i.test(call.name) ? 'powershell' : 'bash'} text={command} />{Object.keys(options).length > 0 && <>{'\n'}<HighlightedCode language="json" text={JSON.stringify(options, null, 2)} /></>}</> : <HighlightedCode language="json" text={JSON.stringify(call.input, null, 2)} />}
  </>;
}
