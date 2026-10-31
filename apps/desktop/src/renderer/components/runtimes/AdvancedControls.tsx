import { useState } from 'react';
import {
  RUNTIME_ENV_HINTS,
  type FitRequest,
  type KvCacheDtype,
  type ModelFacts,
  type RuntimeCapabilities,
  type RuntimeKind,
} from '@nekko-agent/shared';
import { CheckIcon, CopyIcon } from '../../icons.js';
import { formatTokens } from './verdict.js';

/**
 * The expert layer, collapsed until asked for.
 *
 * Every control here is gated on a capability rather than a runtime name. A
 * setting the runtime only reads at startup renders disabled with the exact
 * environment variable to set, because showing it as a live control would be a
 * lie: the value would not take effect until the server restarts.
 */

export function AdvancedControls({
  kind,
  capabilities,
  facts,
  request,
  onChange,
}: {
  kind: RuntimeKind;
  capabilities: RuntimeCapabilities;
  facts: ModelFacts;
  request: FitRequest;
  onChange: (patch: Partial<FitRequest>) => void;
}) {
  if (capabilities.configuredAtLaunch) {
    return <LaunchCommand facts={facts} request={request} />;
  }

  const envNames = RUNTIME_ENV_HINTS[kind] ?? {};

  return (
    <details className="mt-3 rounded-lg border" style={{ borderColor: 'var(--line)' }}>
      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-ink-faint">
        Advanced
      </summary>
      <div className="space-y-3 border-t px-3 py-3" style={{ borderColor: 'var(--line)' }}>
        <Row
          label="Parallel slots"
          hint={
            capabilities.canSetParallel === 'server-env'
              ? `Set ${envNames.parallel ?? 'the server env'} and restart the server. Each slot gets its own full KV cache, so 4 slots means 4x the cache at the same context.`
              : 'Each concurrent slot gets its own full KV cache.'
          }
          restartRequired={capabilities.canSetParallel === 'server-env'}
          env={capabilities.canSetParallel === 'server-env' ? `${envNames.parallel}=${request.parallelSlots}` : undefined}
        >
          <input
            type="number"
            min={1}
            max={16}
            className="input w-20 py-1 text-xs"
            value={request.parallelSlots}
            onChange={(e) => onChange({ parallelSlots: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Row>

        <Row
          label="KV cache type"
          hint={
            capabilities.canSetKvCacheType === 'server-env'
              ? `Set ${envNames.kvCacheType ?? 'the server env'} and restart the server. q8_0 roughly halves the cache.`
              : 'A smaller element halves or quarters the cache, at a small quality cost.'
          }
          restartRequired={capabilities.canSetKvCacheType === 'server-env'}
          env={
            capabilities.canSetKvCacheType === 'server-env'
              ? `${envNames.kvCacheType}=${request.kvCacheDtype}`
              : undefined
          }
        >
          <select
            className="input w-28 py-1 text-xs"
            value={request.kvCacheDtype}
            onChange={(e) => onChange({ kvCacheDtype: e.target.value as KvCacheDtype })}
          >
            <option value="f16">f16 (full)</option>
            <option value="q8_0">q8_0 (half)</option>
            <option value="q4_0">q4_0 (quarter)</option>
          </select>
        </Row>

        {capabilities.canSetGpuLayers && (
          <Row
            label="GPU offload"
            hint={
              facts.layers
                ? `How much of the model's ${facts.layers} layers run on the GPU. The rest run on the CPU.`
                : 'How much of the model runs on the GPU. The rest runs on the CPU.'
            }
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(request.gpuLayerFraction * 100)}
                onChange={(e) => onChange({ gpuLayerFraction: Number(e.target.value) / 100 })}
                className="w-32"
              />
              <span className="w-10 text-right font-mono text-2xs text-ink-faint">
                {Math.round(request.gpuLayerFraction * 100)}%
              </span>
            </div>
          </Row>
        )}

        {facts.maxContext && (
          <p className="text-2xs text-ink-faint">
            This model supports up to {formatTokens(facts.maxContext)} of context
            {facts.quantization ? `, quantized as ${facts.quantization}` : ''}.
          </p>
        )}
      </div>
    </details>
  );
}

function Row({
  label,
  hint,
  children,
  restartRequired,
  env,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
  restartRequired?: boolean;
  env?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs">{label}</label>
        {children}
      </div>
      <p className="mt-0.5 text-2xs text-ink-faint">{hint}</p>
      {restartRequired && env && (
        <div className="mt-1 flex items-center gap-1">
          <code className="rounded bg-[color-mix(in_srgb,var(--ink-faint)_10%,transparent)] px-1.5 py-0.5 font-mono text-2xs">
            {env}
          </code>
          <CopyButton text={env} />
          <span className="text-2xs text-ink-faint">restart required</span>
        </div>
      )}
    </div>
  );
}

/**
 * vLLM's controls are its launch command, so that is what we show. The planner
 * still does the math; the user runs the result themselves.
 */
function LaunchCommand({ facts, request }: { facts: ModelFacts; request: FitRequest }) {
  const parts = [
    'vllm serve',
    facts.id,
    `--max-model-len ${request.contextTokens}`,
    `--max-num-seqs ${request.parallelSlots}`,
    `--gpu-memory-utilization ${request.gpuLayerFraction.toFixed(2)}`,
  ];
  if (request.kvCacheDtype === 'fp8' || request.kvCacheDtype === 'q8_0') parts.push('--kv-cache-dtype fp8');
  const cmd = parts.join(' ');

  return (
    <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }}>
      <p className="text-xs">Launch command</p>
      <p className="mt-0.5 text-2xs text-ink-faint">
        vLLM serves one model per process and takes its whole configuration at launch, so these
        settings are a command to run rather than controls Nekko Agent can apply.
      </p>
      <div className="mt-2 flex items-start gap-1.5">
        <code className="flex-1 break-all rounded bg-[color-mix(in_srgb,var(--ink-faint)_10%,transparent)] px-2 py-1.5 font-mono text-2xs">
          {cmd}
        </code>
        <CopyButton text={cmd} />
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-ghost px-1.5 py-1"
      title={copied ? 'Copied' : 'Copy'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* denied clipboard, nothing worth surfacing */
        }
      }}
    >
      {copied ? (
        <span style={{ color: 'var(--success)' }}>
          <CheckIcon className="h-3 w-3" />
        </span>
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
    </button>
  );
}
