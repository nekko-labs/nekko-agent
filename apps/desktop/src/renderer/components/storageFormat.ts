/**
 * Decimal units, as the disk's maker and the OS count them: one decimal under 10.
 * `binary` counts in 1024s, as Nekko Cloud's plans do (Pro's 5 GB is 5 GiB).
 */
export function formatBytes(n: number, binary = false): string {
  const k = binary ? 1024 : 1000;
  const [v, unit] = n >= k ** 4 ? [n / k ** 4, 'TB'] : n >= k ** 3 ? [n / k ** 3, 'GB'] : n >= k ** 2 ? [n / k ** 2, 'MB'] : [Math.max(1, Math.ceil(n / k)), 'KB'];
  return `${v < 10 && unit !== 'KB' ? Number(v.toFixed(1)) : Math.round(v)} ${unit}`;
}
