import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isKnownProviderModel,
  providerCatalogRoutes,
  resolveProviderRoute,
} from "./provider-route-groups.js";
import { mergeModelsPayload } from "./responses-server.js";
import type { WebProviderRoute } from "./web-provider.js";

function route(
  level: "Low" | "Medium" | "High",
  toolMode: "simple" | "full" = "simple",
  model = "3.1 Pro",
  id = "e6fa",
): WebProviderRoute {
  const effort = level.toLowerCase() as "low" | "medium" | "high";
  return {
    provider: "gemini",
    accountKey: "account-a",
    toolMode,
    inputModalities: ["text"],
    slug: `gemini-web/${id}/${effort}/${toolMode}`,
    displayName: `Gemini ${model} · ${level} · ${toolMode === "full" ? "Full MCP" : "Simple"}`,
    description: "Account-discovered Web model",
    selection: { provider: "gemini", model, thinking: level, activity: "chat" },
    effort,
    mode: effort === "high" ? "high" : "medium",
    contextWindow: 32000,
    contextBudget: {
      contextWindow: 32000,
      hardInputTokenLimit: 32000,
      autoCompactTokenLimit: 28000,
    },
  };
}

const routes = [
  route("Low"),
  route("Medium"),
  route("High"),
  route("Low", "simple", "3.8 Flash", "56fd"),
  route("High", "simple", "3.8 Flash", "56fd"),
  route("Low", "full"),
];

it("publishes one catalog row per Gemini model and tool mode", () => {
  const rows = providerCatalogRoutes(routes);
  assert.deepEqual(
    rows.map((row) => [
      row.slug,
      row.displayName,
      row.effort,
      row.supportedEfforts,
    ]),
    [
      [
        "gemini-web/e6fa/simple",
        "Gemini 3.1 Pro · Simple",
        "medium",
        ["low", "medium", "high"],
      ],
      [
        "gemini-web/56fd/simple",
        "Gemini 3.8 Flash · Simple",
        "low",
        ["low", "high"],
      ],
      ["gemini-web/e6fa/full", "Gemini 3.1 Pro · Full MCP", "low", ["low"]],
    ],
  );
});

it("resolves a grouped row and reasoning effort to the exact observed route", () => {
  const pick = (model: string, reasoning?: unknown) => {
    const resolved = resolveProviderRoute(routes, model, reasoning);
    return resolved && "route" in resolved ? resolved.route.slug : resolved;
  };
  assert.equal(
    pick("gemini-web/e6fa/simple", { effort: "high" }),
    "gemini-web/e6fa/high/simple",
  );
  assert.equal(pick("gemini-web/e6fa/simple"), "gemini-web/e6fa/medium/simple");
  assert.equal(
    pick("gemini-web/e6fa/simple", {}),
    "gemini-web/e6fa/medium/simple",
  );
  // Older saved tasks keep their exact slug.
  assert.equal(
    pick("gemini-web/e6fa/low/simple"),
    "gemini-web/e6fa/low/simple",
  );
  assert.deepEqual(pick("gemini-web/56fd/simple", { effort: "medium" }), {
    unsupportedEffort: "medium",
    slug: "gemini-web/56fd/simple",
    supported: ["low", "high"],
  });
  assert.equal(pick("gemini-web/missing/simple"), undefined);
  assert.equal(isKnownProviderModel(routes, "gemini-web/e6fa/full"), true);
  assert.equal(isKnownProviderModel(routes, "gemini-web/e6fa/low/full"), true);
  assert.equal(isKnownProviderModel(routes, "gemini-web/nope/full"), false);
});

it("keeps routes ungrouped when thinking levels would collide", () => {
  const extended = { ...route("Low"), slug: "gemini-web/e6fa/extended/simple" };
  const rows = providerCatalogRoutes([route("Low"), extended]);
  assert.deepEqual(
    rows.map((row) => row.slug),
    ["gemini-web/e6fa/low/simple", "gemini-web/e6fa/extended/simple"],
  );
});

it("writes grouped Gemini rows with reasoning levels into the Codex catalog", () => {
  const payload = mergeModelsPayload(
    {
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
        { slug: "gemini-web/e6fa/low/simple", display_name: "stale" },
      ],
    },
    undefined,
    "compatibility",
    [],
    true,
    routes,
  ) as {
    models: {
      slug: string;
      supported_reasoning_levels?: { effort: string }[];
    }[];
  };
  const gemini = payload.models.filter((row) =>
    row.slug.startsWith("gemini-web/"),
  );
  assert.deepEqual(
    gemini.map((row) => row.slug),
    [
      "gemini-web/e6fa/simple",
      "gemini-web/56fd/simple",
      "gemini-web/e6fa/full",
    ],
  );
  assert.deepEqual(
    gemini[0]!.supported_reasoning_levels!.map((level) => level.effort),
    ["low", "medium", "high"],
  );
  assert.ok(payload.models.some((row) => row.slug === "gpt-5.6-sol"));
});
