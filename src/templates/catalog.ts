import { pressPitchTemplate } from "./press-pitch.js";
import { socialPostTemplate } from "./social-post.js";
import { campaignAnalysisTemplate } from "./campaign-analysis.js";
import { audienceResearchTemplate } from "./audience-research.js";
import { growthStrategistTemplate } from "./growth-strategist.js";
import { redditScannerTemplate } from "./reddit-scanner.js";
import { communityEngagerTemplate } from "./community-engager.js";
import { signalInviterTemplate } from "./signal-inviter.js";
import type { OutcomeKind } from "../agent/structured.js";

/**
 * One entry of a template's data scope: an MCP tool name plus optional
 * parameters. Plain strings are still accepted ({ tool: name }).
 */
export type DataScopeItem = { tool: string; params?: Record<string, unknown> };

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: "content" | "research" | "analysis";
  recommendedModels: string[];
  dataScope: Array<string | DataScopeItem>;
  /**
   * Declares a structured outcome. When set, the runner appends the output
   * contract to the system prompt, requests JSON mode, parses the response
   * into an envelope, and emits agent_outcomes rows for the Rust worker.
   */
  outputKind?: OutcomeKind;
  /** Suggested cadence when the operator schedules this template (minutes). */
  suggestedIntervalMinutes?: number;
  systemPrompt: string;
  buildPrompt: (input: string, data: Record<string, unknown>) => string;
  outputFormat: "text" | "markdown" | "json";
}

export const TEMPLATES: AgentTemplate[] = [
  growthStrategistTemplate,
  redditScannerTemplate,
  communityEngagerTemplate,
  signalInviterTemplate,
  pressPitchTemplate,
  socialPostTemplate,
  campaignAnalysisTemplate,
  audienceResearchTemplate,
];

export function findTemplate(id: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templateSummaries() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    recommendedModels: t.recommendedModels,
    dataScope: t.dataScope,
  }));
}
