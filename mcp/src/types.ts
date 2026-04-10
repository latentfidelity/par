// ── Core domain types for PAR ────────────────────────────────

export interface Memory {
  id: string;
  type: "decision" | "insight" | "task" | "handoff" | "observation";
  content: string;
  project?: string;
  tags?: string[];
  refs?: string[];
  embedding?: number[];
  pinned?: boolean;
  pinned_reason?: string;
  archived?: boolean;
  archived_at?: string;
  archived_by?: string;
  consolidated_from?: number;
  consolidated_into?: string;
  retention_rule?: { max_age_days: number; applied: string };
  created: string;
}

export interface KnowledgeEntity {
  id: string;
  name: string;
  type: string;
  mentions?: number;
  sources?: string[];
  project?: string | null;
  created?: string;
  last_seen?: string;
}

export interface KnowledgeRelationship {
  id?: string;
  from: string;
  to: string;
  type: string;
  source?: string | null;
  weight?: number;
  created?: string;
  last_seen?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string;
  stack: string[];
  status: "active" | "paused" | "archived" | "ideation";
  repo: string;
  created?: string;
  updated?: string;
  openTasks?: number;
}

export interface Task {
  id: string;
  project: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  status: "todo" | "in-progress" | "done" | "blocked";
  created?: string;
  updated?: string;
}

export interface Snippet {
  id: string;
  title: string;
  content: string;
  language: string;
  tags: string[];
  created?: string;
  updated?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  type: "knowledge" | "execution" | "hybrid";
  tags: string[];
  instructions: string;
  script?: string | null;
  created?: string;
  updated?: string;
}

export interface Dataset {
  id: string;
  name: string;
  domain: string;
  format: string;
  source: string;
  license: string;
  description?: string | null;
  project?: string | null;
  local_path?: string | null;
  size?: string | null;
  tags: string[];
  status: string;
  created?: string;
  updated?: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  capabilities?: string[];
  model?: string;
  channel?: string;
  status: "active" | "idle" | "offline" | "maintenance";
  preferences?: Record<string, unknown>;
  stats?: {
    messages?: number;
    tasks_completed?: number;
  };
  created?: string;
  updated?: string;
}

export interface PAREvent {
  id: string;
  type: string;
  source: string;
  payload?: Record<string, unknown>;
  project?: string;
  severity: "info" | "warn" | "error" | "critical";
  timestamp: string;
  consumed_by: string[];
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  trigger?: { event_type: string };
  project?: string;
  created?: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  action?: string;
  command?: string;
  tool?: string;
  depends_on?: string[];
  gate?: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  status: "running" | "completed" | "failed" | "paused";
  steps: Record<string, { status: string; output?: string; completed_at?: string }>;
  started: string;
  completed?: string;
}

// ── MCP tool response types ─────────────────────────────────

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
