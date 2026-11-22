// The import attribute lets Node load the built dist/ (the CLI, the Local Web UI server); bundlers accept it too.
import catalog from './plan-catalog.json' with { type: 'json' };

/**
 * What each Nekko Cloud plan includes (#3191): the walkthrough's plan step and
 * the website's pricing page both read plan-catalog.json. Prices are never
 * here; they come from Stripe through the Cloud API.
 *
 * Plan ids are the account's plan values: `team` is shown as Enterprise.
 */
export type CatalogPlanId = 'free' | 'pro' | 'team';
/** true: included; false: not included; a string: a short value such as "5 GB" or "Beta". */
export type CatalogValue = boolean | string;

export interface CatalogPlan {
  id: CatalogPlanId;
  name: string;
  /** free: $0; stripe: the price Stripe has for the plan; contact: "Talk to us". */
  price: 'free' | 'stripe' | 'contact';
  tagline: string;
  /** The three main points shown before the full list. */
  points: string[];
}

export interface CatalogRow extends Record<CatalogPlanId, CatalogValue> {
  feature: string;
  /** Not shipped yet. */
  soon?: boolean;
}

export interface CatalogGroup { name: string; rows: CatalogRow[] }

export interface PlanCatalog { plans: CatalogPlan[]; groups: CatalogGroup[] }

export const PLAN_CATALOG: PlanCatalog = { plans: catalog.plans as CatalogPlan[], groups: catalog.groups as CatalogGroup[] };
