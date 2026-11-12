import type { BridgeNativeEffort } from "./native-model-routes.js";
import type { WebProviderRoute } from "./web-provider.js";

/**
 * Codex lists every catalog row as its own model. Provider routes that only
 * differ by thinking level are published as one row per model and tool mode,
 * with the thinking levels offered as Codex reasoning efforts. Requests still
 * resolve to one exact observed route before anything is submitted.
 */

const EFFORT_ORDER: readonly BridgeNativeEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** `gemini-web/<model>/<level>/<mode>` -> `gemini-web/<model>/<mode>`. */
export function groupedProviderSlug(
  route: WebProviderRoute,
): string | undefined {
  const parts = route.slug.split("/");
  if (parts.length !== 4 || !route.toolMode) return undefined;
  const [prefix, model, , mode] = parts;
  if (mode !== route.toolMode) return undefined;
  return `${prefix}/${model}/${mode}`;
}

interface RouteGroup {
  readonly slug: string;
  readonly members: WebProviderRoute[];
}

function groups(routes: readonly WebProviderRoute[]): RouteGroup[] {
  const bySlug = new Map<string, RouteGroup>();
  for (const route of routes) {
    const slug = groupedProviderSlug(route);
    if (!slug) continue;
    const group = bySlug.get(slug) ?? { slug, members: [] };
    group.members.push(route);
    bySlug.set(slug, group);
  }
  const exact = new Set(routes.map((route) => route.slug));
  return [...bySlug.values()].filter((group) => {
    // Every member needs a distinct effort, or a request could not say which
    // observed thinking level it means.
    const efforts = new Set(group.members.map((route) => route.effort));
    return (
      efforts.size === group.members.length &&
      group.members.every(
        (route) =>
          route.selection.model === group.members[0]!.selection.model &&
          route.accountKey === group.members[0]!.accountKey,
      ) &&
      !exact.has(group.slug)
    );
  });
}

function defaultMember(members: readonly WebProviderRoute[]): WebProviderRoute {
  return (
    members.find((route) => route.effort === "medium") ??
    members.find((route) => route.effort === "low") ??
    members[0]!
  );
}

function stripThinking(route: WebProviderRoute): string {
  const thinking = route.selection.thinking;
  return thinking
    ? route.displayName.replace(` · ${thinking} · `, " · ")
    : route.displayName;
}

/** Rows to publish in the Codex model catalog, in first-seen order. */
export function providerCatalogRoutes(
  routes: readonly WebProviderRoute[],
): WebProviderRoute[] {
  const grouped = groups(routes);
  const groupOf = new Map<string, RouteGroup>();
  for (const group of grouped)
    for (const member of group.members) groupOf.set(member.slug, group);
  const published = new Set<string>();
  const rows: WebProviderRoute[] = [];
  for (const route of routes) {
    const group = groupOf.get(route.slug);
    if (!group) {
      rows.push(route);
      continue;
    }
    if (published.has(group.slug)) continue;
    published.add(group.slug);
    const base = defaultMember(group.members);
    const efforts = group.members
      .map((member) => member.effort as BridgeNativeEffort)
      .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    rows.push({
      ...base,
      slug: group.slug,
      displayName: stripThinking(base),
      supportedEfforts: efforts,
    });
  }
  return rows;
}

/** True when `model` names an exact provider route or a published group. */
export function isKnownProviderModel(
  routes: readonly WebProviderRoute[] | undefined,
  model: unknown,
): boolean {
  if (typeof model !== "string" || !routes) return false;
  return (
    routes.some((route) => route.slug === model) ||
    groups(routes).some((group) => group.slug === model)
  );
}

export type ProviderRouteResolution =
  | { readonly route: WebProviderRoute }
  | {
      readonly unsupportedEffort: unknown;
      readonly slug: string;
      readonly supported: readonly BridgeNativeEffort[];
    }
  | undefined;

/**
 * Resolve a requested model and reasoning effort to one exact observed route.
 * Exact route slugs keep working for tasks saved before grouping.
 */
export function resolveProviderRoute(
  routes: readonly WebProviderRoute[] | undefined,
  model: unknown,
  reasoning: unknown,
): ProviderRouteResolution {
  if (typeof model !== "string" || !routes) return undefined;
  const record =
    reasoning && typeof reasoning === "object"
      ? (reasoning as Record<string, unknown>)
      : undefined;
  const requested = record?.effort;
  const invalidShape = reasoning !== undefined && !record;
  const exact = routes.find((route) => route.slug === model);
  if (exact) {
    if (invalidShape || (requested !== undefined && requested !== exact.effort))
      return {
        unsupportedEffort: requested,
        slug: exact.slug,
        supported: [exact.effort as BridgeNativeEffort],
      };
    return { route: exact };
  }
  const group = groups(routes).find((candidate) => candidate.slug === model);
  if (!group) return undefined;
  if (invalidShape)
    return {
      unsupportedEffort: requested,
      slug: group.slug,
      supported: group.members.map((m) => m.effort as BridgeNativeEffort),
    };
  if (requested === undefined) return { route: defaultMember(group.members) };
  const match = group.members.find((member) => member.effort === requested);
  if (!match)
    return {
      unsupportedEffort: requested,
      slug: group.slug,
      supported: group.members.map((m) => m.effort as BridgeNativeEffort),
    };
  return { route: match };
}
