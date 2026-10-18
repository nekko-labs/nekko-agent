/**
 * Plan → feature entitlements. The OSS app NEVER license-checks (everything is
 * on locally); only Nekko Cloud gates features server-side, here. Keep this the
 * single source of truth so the dispatch layer and the `/api/auth/me` response
 * agree on what an account can do.
 */
export type Plan = 'free' | 'pro' | 'team';

export interface Entitlements {
  plan: Plan;
  /** Max workspace folders an account may register (Infinity = unlimited). */
  maxWorkspaces: number;
  /** Zero-data-retention mode available. */
  zdr: boolean;
  /** Cloud-synced chat history + files. */
  cloudSync: boolean;
  /** Pre-registered managed OAuth connectors (Gmail/Drive/Slack/Discord). */
  managedConnectors: boolean;
  /** Max paired remote devices (phones) for relay access. */
  maxDevices: number;
}

const PLANS: Record<Plan, Omit<Entitlements, 'plan'>> = {
  free: { maxWorkspaces: 2, zdr: false, cloudSync: false, managedConnectors: false, maxDevices: 1 },
  pro: { maxWorkspaces: Infinity, zdr: true, cloudSync: true, managedConnectors: true, maxDevices: 5 },
  team: { maxWorkspaces: Infinity, zdr: true, cloudSync: true, managedConnectors: true, maxDevices: 25 },
};

export function entitlements(plan: Plan): Entitlements {
  return { plan, ...PLANS[plan] };
}

/** Throws a user-facing error when a numeric limit would be exceeded. */
export function requireWithin(plan: Plan, feature: 'maxWorkspaces' | 'maxDevices', currentCount: number): void {
  const limit = entitlements(plan)[feature];
  if (currentCount >= limit) {
    throw new Error(
      `Your ${plan} plan allows ${limit === Infinity ? 'unlimited' : limit} ${
        feature === 'maxWorkspaces' ? 'workspaces' : 'devices'
      }. Upgrade to add more.`,
    );
  }
}

/** Throws a user-facing error when a boolean feature isn't on the plan. */
export function requireFeature(plan: Plan, feature: 'zdr' | 'cloudSync' | 'managedConnectors'): void {
  if (!entitlements(plan)[feature]) {
    throw new Error(`${feature} is not available on the ${plan} plan. Upgrade to enable it.`);
  }
}
