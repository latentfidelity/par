/**
 * Event & workflow tools: event_trigger, event_subscribe, event_log,
 * workflow_register, workflow_run, workflow_status, workflow_list,
 * system_changelog
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, readJSON, writeJSON, listJSON, textResult, errorResult } from "../lib/storage.js";

export function registerEventTools(server: McpServer) {

  // ┌─────────────────────────────────────────────────────────┐
  // │  EVENT SYSTEM (v4.0)                                     │
  // └─────────────────────────────────────────────────────────┘

  // NOTE: event_emit removed in v6.6 — event_trigger is a strict superset
  // (emits event + matches subscribers + triggers workflows).

  server.tool(
    "event_subscribe",
    "Subscribe an agent or service to specific event types. Subscriptions are stored persistently and matched on event_trigger.",
    {
      subscriber: z.string().describe("Agent or service ID subscribing (e.g. 'my-agent')"),
      type_pattern: z.string().describe("Event type pattern to match (e.g. 'deploy.*', 'task.updated')"),
      action: z.string().optional().describe("Action to take on match (e.g. 'notify_discord', 'log', 'run_workflow')"),
    },
    async ({ subscriber, type_pattern, action }) => {
      const subId = `event_sub__${subscriber}__${type_pattern.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const kvPath = path.join(META_DIR, "kv", `${subId}.json`);

      writeJSON(kvPath, {
        key: subId,
        value: JSON.stringify({
          subscriber,
          type_pattern,
          action: action || "log",
          created: new Date().toISOString(),
        }),
        updated: new Date().toISOString(),
      });

      return textResult({ subscribed: subscriber, pattern: type_pattern, action: action || "log" });
    },
  );

  server.tool(
    "event_log",
    "Query the event log. Retrieve recent events filtered by type, source, project, or severity.",
    {
      type: z.string().optional().describe("Filter by event type prefix (e.g. 'deploy')"),
      source: z.string().optional().describe("Filter by source agent/service"),
      project: z.string().optional().describe("Filter by project"),
      severity: z.enum(["info", "warn", "error", "critical"]).optional().describe("Filter by severity"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ type, source, project, severity, limit }) => {
      let events = listJSON(path.join(META_DIR, "events"));

      if (type) events = events.filter(e => e.type.startsWith(type));
      if (source) events = events.filter(e => e.source === source);
      if (project) events = events.filter(e => e.project === project);
      if (severity) events = events.filter(e => e.severity === severity);

      events = events
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, Math.min(limit || 20, 100));

      return textResult({ total: events.length, events });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  WORKFLOW ENGINE (v4.0)                                  │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "workflow_register",
    "Register or update a workflow definition. Workflows are executable step sequences with optional conditions and parallel branches.",
    {
      id: z.string().describe("Unique workflow ID (e.g. 'deploy-par', 'morning-standup')"),
      name: z.string().describe("Human-readable workflow name"),
      description: z.string().optional().describe("What this workflow does"),
      project: z.string().optional().describe("Associated project"),
      steps: z.string().describe("JSON array of steps: [{id, name, command?, tool?, depends_on?, gate?}]"),
      trigger: z.string().optional().describe("Event type that auto-triggers this workflow (e.g. 'deploy.requested')"),
    },
    async ({ id, name, description, project, steps, trigger }) => {
      const wfPath = path.join(META_DIR, "workflows", `${id}.json`);
      const existing = readJSON(wfPath);

      const workflow = {
        id,
        name,
        description: description || "",
        project: project || null,
        steps: JSON.parse(steps),
        trigger: trigger || null,
        version: (existing?.version || 0) + 1,
        runs: existing?.runs || 0,
        last_run: existing?.last_run || null,
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };

      writeJSON(wfPath, workflow);
      return textResult({
        registered: id,
        name,
        step_count: workflow.steps.length,
        version: workflow.version,
        trigger: workflow.trigger,
      });
    },
  );

  server.tool(
    "workflow_run",
    "Start or advance a workflow execution. Creates a run record tracking step completion, timing, and outputs.",
    {
      workflow_id: z.string().describe("Workflow definition ID"),
      run_id: z.string().optional().describe("Existing run ID to advance (omit to start new)"),
      step_id: z.string().optional().describe("Step to mark complete (for advancing)"),
      step_output: z.string().optional().describe("Output/result from completed step"),
      status: z.enum(["running", "completed", "failed", "paused"]).optional().describe("Set run status (default: running)"),
    },
    async ({ workflow_id, run_id, step_id, step_output, status }) => {
      const wfPath = path.join(META_DIR, "workflows", `${workflow_id}.json`);
      const workflow = readJSON(wfPath);
      if (!workflow) return errorResult(`Workflow not found: ${workflow_id}`);

      // New run
      if (!run_id) {
        const newRunId = randomUUID().slice(0, 8);
        const run = {
          run_id: newRunId,
          workflow_id,
          workflow_name: workflow.name,
          status: "running",
          started: new Date().toISOString(),
          updated: new Date().toISOString(),
          completed: null,
          steps: workflow.steps.map((s: any) => ({
            id: s.id,
            name: s.name,
            status: "pending",
            started: null,
            completed: null,
            output: null,
          })),
          current_step: workflow.steps[0]?.id || null,
        };

        // Store run as KV
        writeJSON(path.join(META_DIR, "kv", `wf_run__${newRunId}.json`), {
          key: `wf_run__${newRunId}`,
          value: JSON.stringify(run),
          updated: run.updated,
        });

        workflow.runs = (workflow.runs || 0) + 1;
        workflow.last_run = newRunId;
        writeJSON(wfPath, workflow);

        // Emit event
        const eventId = randomUUID();
        writeJSON(path.join(META_DIR, "events", `${eventId}.json`), {
          id: eventId,
          type: "workflow.started",
          source: "workflow-engine",
          project: workflow.project,
          payload: { workflow_id, run_id: newRunId },
          severity: "info",
          timestamp: new Date().toISOString(),
          consumed_by: [],
        });

        return textResult({ started: newRunId, workflow: workflow_id, steps: run.steps.length, current_step: run.current_step });
      }

      // Advance existing run
      const runKv = readJSON(path.join(META_DIR, "kv", `wf_run__${run_id}.json`));
      if (!runKv) return errorResult(`Run not found: ${run_id}`);
      const run = JSON.parse(runKv.value);

      if (step_id) {
        const step = run.steps.find((s: any) => s.id === step_id);
        if (step) {
          step.status = "completed";
          step.completed = new Date().toISOString();
          step.output = step_output || null;
        }

        // Advance to next pending step
        const nextStep = run.steps.find((s: any) => s.status === "pending");
        if (nextStep) {
          nextStep.status = "running";
          nextStep.started = new Date().toISOString();
          run.current_step = nextStep.id;
        } else {
          run.current_step = null;
        }
      }

      if (status) {
        run.status = status;
        if (status === "completed" || status === "failed") {
          run.completed = new Date().toISOString();
        }
      }

      // Auto-complete if all steps done
      if (run.steps.every((s: any) => s.status === "completed")) {
        run.status = "completed";
        run.completed = new Date().toISOString();
        run.current_step = null;
      }

      run.updated = new Date().toISOString();
      writeJSON(path.join(META_DIR, "kv", `wf_run__${run_id}.json`), {
        key: `wf_run__${run_id}`,
        value: JSON.stringify(run),
        updated: run.updated,
      });

      return textResult({
        run_id,
        status: run.status,
        current_step: run.current_step,
        completed_steps: run.steps.filter((s: any) => s.status === "completed").length,
        total_steps: run.steps.length,
      });
    },
  );

  server.tool(
    "workflow_status",
    "Get the status of a workflow run including step-by-step progress",
    {
      run_id: z.string().describe("Workflow run ID"),
    },
    async ({ run_id }) => {
      const runKv = readJSON(path.join(META_DIR, "kv", `wf_run__${run_id}.json`));
      if (!runKv) return errorResult(`Run not found: ${run_id}`);
      const run = JSON.parse(runKv.value);
      return textResult(run);
    },
  );

  server.tool(
    "workflow_list",
    "List registered workflow definitions with their run counts and triggers",
    {
      project: z.string().optional().describe("Filter by project"),
    },
    async ({ project }) => {
      let workflows = listJSON(path.join(META_DIR, "workflows"));
      if (project) workflows = workflows.filter(w => w.project === project);

      return textResult({
        total: workflows.length,
        workflows: workflows.map(w => ({
          id: w.id,
          name: w.name,
          project: w.project,
          step_count: w.steps?.length || 0,
          trigger: w.trigger,
          runs: w.runs || 0,
          last_run: w.last_run,
          version: w.version,
          updated: w.updated,
        })),
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  EVENT TRIGGER — unified event emission (v6.6)           │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "event_trigger",
    "Emit a structured event, match subscribers, and auto-start any workflows with matching triggers. Unified event tool (replaces event_emit).",
    {
      type: z.string().describe("Event type (e.g. 'deploy.requested', 'task.updated')"),
      source: z.string().optional().describe("Emitting agent or service (default: 'event_trigger')"),
      project: z.string().optional().describe("Associated project"),
      payload: z.string().optional().describe("JSON payload string"),
      severity: z.enum(["info", "warn", "error", "critical"]).optional().describe("Event severity (default: info)"),
    },
    async ({ type, source, project, payload, severity }) => {
      const eventId = randomUUID().slice(0, 8);
      const event = {
        id: eventId,
        type,
        source: source || "event_trigger",
        project: project || null,
        payload: payload ? JSON.parse(payload) : {},
        severity: severity || "info",
        timestamp: new Date().toISOString(),
        consumed_by: [],
      };
      writeJSON(path.join(META_DIR, "events", `${eventId}.json`), event);

      // Match subscribers
      const kvDir = path.join(META_DIR, "kv");
      const subs = listJSON(kvDir).filter(kv => kv.key?.startsWith("event_sub__"));
      const subscribers = [];
      for (const sub of subs) {
        try {
          const cfg = JSON.parse(sub.value);
          if (cfg.type_pattern && type.startsWith(cfg.type_pattern.replace("*", ""))) {
            subscribers.push({ subscriber: cfg.subscriber, action: cfg.action });
          }
        } catch {}
      }

      // Match workflows
      const workflows = listJSON(path.join(META_DIR, "workflows"));
      const triggered = [];
      for (const wf of workflows) {
        const triggerMatch = wf.trigger?.event_type === type ||
          (wf.trigger && typeof wf.trigger === "string" && type.startsWith(wf.trigger.replace("*", "")));
        if (triggerMatch) {
          const runId = randomUUID().slice(0, 8);
          const run = {
            id: runId, workflow_id: wf.id, workflow_name: wf.name,
            triggered_by: eventId, event_type: type, project,
            steps: wf.steps.map((s: any) => ({ ...s, status: "pending" })),
            status: "triggered", started_at: new Date().toISOString(),
          };
          const runDir = path.join(META_DIR, "workflow_runs");
          if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
          writeJSON(path.join(runDir, `${runId}.json`), run);
          triggered.push({ workflow: wf.id, name: wf.name, run_id: runId });
        }
      }

      return textResult({
        event: { id: eventId, type, source: event.source, severity: event.severity, project },
        subscribers: subscribers.length ? subscribers : undefined,
        workflows_triggered: triggered.length,
        workflows: triggered.length ? triggered : undefined,
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SYSTEM CHANGELOG (v6.5)                                 │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "system_changelog",
    "Generate a human-readable changelog of system activity. Aggregates recent events, workflow runs, memory operations, and KG changes into a chronological summary. Use to understand what happened since your last session.",
    {
      hours: z.number().optional().describe("Look back N hours (default 24)"),
      project: z.string().optional().describe("Filter to specific project"),
    },
    async ({ hours, project }) => {
      const lookback = (hours || 24) * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - lookback);

      // Events
      const events = listJSON(path.join(META_DIR, "events"))
        .filter(e => new Date(e.timestamp) > cutoff)
        .filter(e => !project || e.project === project)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Memories created/archived
      const allMems = listJSON(path.join(META_DIR, "memory"));
      const newMems = allMems
        .filter(m => new Date(m.created) > cutoff)
        .filter(m => !project || m.project === project);
      const archivedMems = allMems
        .filter(m => m.archived && m.archived_at && new Date(m.archived_at) > cutoff)
        .filter(m => !project || m.project === project);

      // Workflow runs
      const runDir = path.join(META_DIR, "workflow_runs");
      const runs = fs.existsSync(runDir)
        ? listJSON(runDir).filter(r => new Date(r.started_at) > cutoff).filter(r => !project || r.project === project)
        : [];

      // Tasks changed
      const tasks = listJSON(path.join(META_DIR, "tasks"))
        .filter(t => !project || t.project === project);
      const recentTasks = tasks.filter(t =>
        (t.updated && new Date(t.updated) > cutoff) ||
        new Date(t.created) > cutoff
      );

      // Build timeline
      const timeline = [];

      for (const e of events) {
        timeline.push({ time: e.timestamp, category: "event", detail: `[${e.type}] ${e.source}${e.project ? ` (${e.project})` : ""}` });
      }
      for (const m of newMems) {
        timeline.push({ time: m.created, category: "memory", detail: `New ${m.type}: ${m.content?.slice(0, 80)}...` });
      }
      for (const m of archivedMems) {
        timeline.push({ time: m.archived_at, category: "archive", detail: `Archived ${m.type}: ${m.content?.slice(0, 60)}...` });
      }
      for (const r of runs) {
        timeline.push({ time: r.started_at, category: "workflow", detail: `Workflow ${r.workflow_name || r.workflow_id} → ${r.status}` });
      }

      timeline.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

      return textResult({
        period: `Last ${hours || 24} hours`,
        ...(project ? { project } : {}),
        summary: {
          events: events.length,
          new_memories: newMems.length,
          archived_memories: archivedMems.length,
          workflow_runs: runs.length,
          task_changes: recentTasks.length,
        },
        timeline: timeline.slice(-50).map(t => ({
          time: new Date(t.time).toLocaleString(),
          category: t.category,
          detail: t.detail,
        })),
      });
    },
  );

}
