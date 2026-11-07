/** Agent groups mount only this many cards until explicitly expanded. */
export const AGENT_GROUP_LIMIT = 20;

/** Keep a selected row reachable without mounting every row preceding it. */
export function agentGroupRows<T>(rows: T[], expanded: boolean, keepIndex = -1): T[] {
  if (expanded || rows.length <= AGENT_GROUP_LIMIT) return rows;
  if (keepIndex >= AGENT_GROUP_LIMIT && keepIndex < rows.length) {
    return [...rows.slice(0, AGENT_GROUP_LIMIT - 1), rows[keepIndex]];
  }
  return rows.slice(0, AGENT_GROUP_LIMIT);
}
