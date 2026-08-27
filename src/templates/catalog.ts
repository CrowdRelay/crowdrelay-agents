import { pressPitchTemplate } from "./press-pitch";
import { socialPostTemplate } from "./social-post";

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: "content" | "research" | "analysis";
  recommendedModels: string[];
  dataScope: string[];
  systemPrompt: string;
  buildPrompt: (input: string, data: Record<string, unknown>) => string;
  outputFormat: "text" | "markdown" | "json";
  outputSchema?: Record<string, unknown>;
}

export const TEMPLATES: AgentTemplate[] = [
  pressPitchTemplate,
  socialPostTemplate,
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
