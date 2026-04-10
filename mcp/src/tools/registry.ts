/**
 * Registry tools: project_*, task_*, snippet_*, skill_*, dataset_*
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, safeId, readJSON, writeJSON, listJSON, textResult, errorResult, errorMessage } from "../lib/storage.js";

export function registerRegistryTools(server: McpServer) {
  // ┌─────────────────────────────────────────────────────────┐
  // │  PROJECT REGISTRY                                       │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "project_register",
    "Register a project in the persistent project registry",
    {
      id: z.string().describe("Unique project identifier (e.g. 'my-project', 'web-app')"),
      name: z.string().describe("Human-readable project name"),
      path: z.string().describe("Local filesystem path to the project"),
      description: z.string().optional().describe("Brief project description"),
      stack: z
        .string()
        .optional()
        .describe("Comma-separated tech stack (e.g. 'python,pillow,numpy')"),
      status: z
        .enum(["active", "paused", "archived", "ideation"])
        .optional()
        .describe("Project status"),
      repo: z.string().optional().describe("Git repository URL"),
    },
    async ({ id, name, path: projPath, description, stack, status, repo }) => {
      const filePath = path.join(META_DIR, "projects", `${id}.json`);
      const existing = readJSON(filePath);
      const project = {
        id,
        name,
        path: projPath,
        description: description || "",
        stack: stack ? stack.split(",").map((s) => s.trim()) : [],
        status: status || "active",
        repo: repo || "",
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(filePath, project);
      return textResult(`Project registered: ${name} (${id})`);
    },
  );

  server.tool(
    "project_list",
    "List all registered projects",
    {
      status: z
        .enum(["active", "paused", "archived", "ideation", "all"])
        .optional()
        .describe("Filter by status"),
    },
    async ({ status }) => {
      let projects = listJSON(path.join(META_DIR, "projects"));
      if (status && status !== "all") {
        projects = projects.filter((p) => p.status === status);
      }
      if (!projects.length) return textResult("No projects registered yet.");
      return textResult(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          stack: p.stack,
          path: p.path,
        })),
      );
    },
  );

  server.tool(
    "project_get",
    "Get full details of a registered project",
    {
      id: z.string().describe("Project identifier"),
    },
    async ({ id }) => {
      const project = readJSON(path.join(META_DIR, "projects", `${id}.json`));
      if (!project) return errorResult(`Project not found: ${id}`);
      // Include open tasks count
      const tasks = listJSON(path.join(META_DIR, "tasks")).filter(
        (t) => t.project === id && t.status !== "done",
      );
      project.openTasks = tasks.length;
      return textResult(project);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  TASK QUEUE                                             │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "task_add",
    "Add a task to the persistent task queue",
    {
      project: z.string().describe("Project identifier this task belongs to"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Detailed task description"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Task priority"),
    },
    async ({ project, title, description, priority }) => {
      const id = randomUUID().slice(0, 8);
      const task = {
        id,
        project,
        title,
        description: description || "",
        priority: priority || "medium",
        status: "todo",
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(path.join(META_DIR, "tasks", `${id}.json`), task);
      return textResult(`Task added: [${id}] ${title} (${project})`);
    },
  );

  server.tool(
    "task_list",
    "List tasks from the persistent task queue",
    {
      project: z.string().optional().describe("Filter by project identifier"),
      status: z
        .enum(["todo", "in-progress", "done", "blocked", "all"])
        .optional()
        .describe("Filter by status"),
    },
    async ({ project, status }) => {
      let tasks = listJSON(path.join(META_DIR, "tasks"));
      if (project) tasks = tasks.filter((t: any) => t.project === project);
      if (status && status !== "all") tasks = tasks.filter((t: any) => t.status === status);
      tasks.sort((a: any, b: any) => {
        const prio = { critical: 0, high: 1, medium: 2, low: 3 };
        return (prio[a.priority as keyof typeof prio] || 2) - (prio[b.priority as keyof typeof prio] || 2);
      });
      if (!tasks.length) return textResult("No tasks found.");
      return textResult(
        tasks.map((t: any) => ({
          id: t.id,
          project: t.project,
          title: t.title,
          priority: t.priority,
          status: t.status,
        })),
      );
    },
  );

  server.tool(
    "task_update",
    "Update a task's status, priority, or details",
    {
      id: z.string().describe("Task ID"),
      status: z.enum(["todo", "in-progress", "done", "blocked"]).optional().describe("New status"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority"),
      title: z.string().optional().describe("Updated title"),
      description: z.string().optional().describe("Updated description"),
    },
    async ({ id, status, priority, title, description }) => {
      const filePath = path.join(META_DIR, "tasks", `${id}.json`);
      const task = readJSON(filePath);
      if (!task) return errorResult(`Task not found: ${id}`);
      if (status) task.status = status;
      if (priority) task.priority = priority;
      if (title) task.title = title;
      if (description) task.description = description;
      task.updated = new Date().toISOString();
      writeJSON(filePath, task);
      return textResult(`Task updated: [${id}] ${task.title} → ${task.status}`);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SNIPPET STORE                                          │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "snippet_save",
    "Save a reusable code snippet or pattern",
    {
      title: z.string().describe("Snippet title (e.g. 'Docker healthcheck pattern')"),
      content: z.string().describe("The snippet content"),
      language: z.string().optional().describe("Language (e.g. 'bash', 'yaml', 'javascript')"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags (e.g. 'docker,healthcheck,devops')"),
    },
    async ({ title, content, language, tags }) => {
      const id = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+$/, "");
      const snippet = {
        id,
        title,
        content,
        language: language || "text",
        tags: tags ? tags.split(",").map((t: any) => t.trim()) : [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(path.join(META_DIR, "snippets", `${id}.json`), snippet);
      return textResult(`Snippet saved: ${title} [${id}]`);
    },
  );

  server.tool(
    "snippet_search",
    "Search saved snippets by keyword or tag",
    {
      query: z.string().describe("Search query (matches title, tags, and content)"),
    },
    async ({ query }) => {
      const snippets = listJSON(path.join(META_DIR, "snippets"));
      const q = query.toLowerCase();
      const matches = snippets.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.content.toLowerCase().includes(q) ||
          s.tags.some((t: string) => t.toLowerCase().includes(q)),
      );
      if (!matches.length) return textResult(`No snippets matched: "${query}"`);
      return textResult(
        matches.map((s) => ({
          id: s.id,
          title: s.title,
          language: s.language,
          tags: s.tags,
          preview: s.content.slice(0, 120) + (s.content.length > 120 ? "..." : ""),
        })),
      );
    },
  );

  server.tool(
    "snippet_get",
    "Get full content of a saved snippet",
    {
      id: z.string().describe("Snippet identifier"),
    },
    async ({ id }) => {
      const snippet = readJSON(path.join(META_DIR, "snippets", `${id}.json`));
      if (!snippet) return errorResult(`Snippet not found: ${id}`);
      return textResult(snippet);
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SKILL SYSTEM                                           │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "skill_list",
    "List all available agent skills",
    {
      tag: z.string().optional().describe("Filter by tag"),
      type: z
        .enum(["knowledge", "execution", "hybrid", "all"])
        .optional()
        .describe("Filter by skill type"),
    },
    async ({ tag, type }) => {
      let skills = listJSON(path.join(META_DIR, "skills"));
      if (tag) skills = skills.filter((s) => s.tags?.some((t: string) => t.includes(tag)));
      if (type && type !== "all") skills = skills.filter((s) => s.type === type);
      if (!skills.length) return textResult("No skills found.");
      return textResult(
        skills.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          tags: s.tags,
          description: s.description,
        })),
      );
    },
  );

  server.tool(
    "skill_get",
    "Get full skill definition including instructions",
    {
      id: z.string().describe("Skill identifier"),
    },
    async ({ id }) => {
      const skill = readJSON(path.join(META_DIR, "skills", `${id}.json`));
      if (!skill) return errorResult(`Skill not found: ${id}`);
      return textResult(skill);
    },
  );

  server.tool(
    "skill_create",
    "Create or update an agent skill",
    {
      id: z.string().describe("Unique skill identifier (e.g. 'deploy-docker')"),
      name: z.string().describe("Human-readable skill name"),
      description: z.string().describe("What the skill does"),
      type: z
        .enum(["knowledge", "execution", "hybrid"])
        .describe(
          "Skill type: knowledge (instructions only), execution (runs on server), hybrid (both)",
        ),
      tags: z.string().optional().describe("Comma-separated tags"),
      instructions: z.string().describe("Step-by-step instructions in markdown"),
      script: z
        .string()
        .optional()
        .describe("Shell script to execute (for execution/hybrid types)"),
    },
    async ({ id, name, description, type, tags, instructions, script }) => {
      const filePath = path.join(META_DIR, "skills", `${id}.json`);
      const existing = readJSON(filePath);
      const skill = {
        id,
        name,
        description,
        type,
        tags: tags ? tags.split(",").map((t: any) => t.trim()) : [],
        instructions,
        script: script || null,
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(filePath, skill);
      return textResult(`Skill ${existing ? "updated" : "created"}: ${name} [${id}]`);
    },
  );

  server.tool(
    "skill_run",
    "Execute a skill's script on the server",
    {
      id: z.string().describe("Skill identifier to execute"),
      args: z.string().optional().describe("Arguments to pass to the script"),
    },
    async ({ id, args }) => {
      const skill = readJSON(path.join(META_DIR, "skills", `${id}.json`));
      if (!skill) return errorResult(`Skill not found: ${id}`);
      if (!skill.script)
        return errorResult(`Skill "${id}" has no executable script. Type: ${skill.type}`);
      if (skill.type === "knowledge")
        return errorResult(`Skill "${id}" is knowledge-only. Read its instructions instead.`);

      try {
        // Write script to temp file and execute (using execFileSync to prevent shell injection)
        const scriptPath = path.join(META_DIR, "skills", `_run_${id}.sh`);
        fs.writeFileSync(scriptPath, skill.script, { mode: 0o755 });
        const execArgs = [scriptPath, ...(args ? args.split(/\s+/).filter(Boolean) : [])];
        const output = execFileSync("bash", execArgs, {
          timeout: 30000,
          cwd: META_DIR,
          env: { ...process.env, META_DIR, SKILL_ID: id },
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
        // Clean up temp script
        fs.unlinkSync(scriptPath);
        return textResult({ executed: id, output: output.trim() });
      } catch (err: unknown) {
        const msg = errorMessage(err);
        const stderr = (err as any)?.stderr || "";
        return errorResult(`Skill execution failed: ${msg}\n${stderr}`);
      }
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  DATASET REGISTRY                                       │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "dataset_register",
    "Register or update a dataset in the global registry",
    {
      id: z.string().describe("Unique dataset identifier (e.g. 'lpc-universal', 'kenney-platformer')"),
      name: z.string().describe("Human-readable dataset name"),
      domain: z.string().describe("Domain category (e.g. 'sprites', 'audio', 'text', 'images', 'video', '3d')"),
      format: z.string().describe("Data format (e.g. 'png-spritesheet', 'wav', 'jsonl', 'parquet')"),
      source: z.string().describe("Source URL or repository"),
      license: z.string().describe("License identifier (e.g. 'CC0', 'CC-BY-SA-3.0', 'MIT', 'GPL-3.0')"),
      description: z.string().optional().describe("What this dataset contains and how it's structured"),
      project: z.string().optional().describe("Project that uses this dataset (e.g. 'my-project')"),
      local_path: z.string().optional().describe("Absolute path on local filesystem"),
      size: z.string().optional().describe("Approximate size (e.g. '1.2GB', '86MB')"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'pixel-art,modular,top-down')"),
      status: z.string().optional().describe("Ingestion status: available, downloaded, processed, archived"),
    },
    async ({ id, name, domain, format, source, license, description, project, local_path, size, tags, status }) => {
      const filePath = path.join(META_DIR, "datasets", `${id}.json`);
      const existing = readJSON(filePath);
      const dataset = {
        id, name, domain, format, source, license,
        description: description || existing?.description || null,
        project: project || existing?.project || null,
        local_path: local_path || existing?.local_path || null,
        size: size || existing?.size || null,
        tags: tags ? tags.split(",").map(t => t.trim()) : existing?.tags || [],
        status: status || existing?.status || "available",
        created: existing?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(filePath, dataset);
      return textResult(`Dataset ${existing ? "updated" : "registered"}: ${name} (${id})`);
    },
  );

  server.tool(
    "dataset_list",
    "List registered datasets, optionally filtered by domain, project, or status",
    {
      domain: z.string().optional().describe("Filter by domain (e.g. 'sprites', 'audio')"),
      project: z.string().optional().describe("Filter by project (e.g. 'my-project')"),
      status: z.string().optional().describe("Filter by status (available/downloaded/processed/archived/all)"),
    },
    async ({ domain, project, status }) => {
      let datasets = listJSON(path.join(META_DIR, "datasets"));
      if (domain) datasets = datasets.filter(d => d.domain === domain);
      if (project) datasets = datasets.filter(d => d.project === project);
      if (status && status !== "all") datasets = datasets.filter(d => d.status === status);
      if (datasets.length === 0) return textResult("No datasets found matching filters.");
      const summary = datasets.map(d =>
        `[${d.id}] ${d.name} | ${d.domain}/${d.format} | ${d.size || '?'} | ${d.status} | ${d.license}`
      ).join("\n");
      return textResult(`${datasets.length} dataset(s):\n${summary}`);
    },
  );

  server.tool(
    "dataset_get",
    "Get full details of a specific dataset",
    {
      id: z.string().describe("Dataset identifier"),
    },
    async ({ id }) => {
      const dataset = readJSON(path.join(META_DIR, "datasets", `${id}.json`));
      if (!dataset) return errorResult(`Dataset not found: ${id}`);
      return textResult(dataset);
    },
  );

  server.tool(
    "dataset_search",
    "Search the sprite reference index by tags, size, and format. Returns matching sprite entries with file paths.",
    {
      tags: z.string().describe("Comma-separated tags to match (AND logic). E.g. 'knight,attack,side-view'"),
      max_size: z.number().optional().describe("Maximum pixel dimension (default 512)"),
      min_size: z.number().optional().describe("Minimum pixel dimension (default 16)"),
      limit: z.number().optional().describe("Maximum results to return (default 20)"),
      sheets_only: z.boolean().optional().describe("Only return spritesheets (default false)"),
    },
    async ({ tags, max_size, min_size, limit, sheets_only }) => {
      const indexPath = "/opt/datasets/index.json";
      let index;
      try {
        index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      } catch (e) {
        return errorResult(`Index not found. Run build_index.py on the server first.`);
      }

      const searchTags = tags.split(",").map(t => t.trim().toLowerCase());
      const maxDim = max_size || 512;
      const minDim = min_size || 16;
      const maxResults = Math.min(limit || 20, 100);

      let results = index.filter((entry: any) => {
        // Tag matching: ALL search tags must be present
        const entryTags = (entry.tags || []).map((t: string) => t.toLowerCase());
        if (!searchTags.every(st => entryTags.includes(st))) return false;

        // Size filtering
        const dim = Math.max(entry.width || 0, entry.height || 0);
        if (dim < minDim || dim > maxDim) return false;

        // Sheet filter
        if (sheets_only && !entry.is_sheet) return false;

        return true;
      });

      // Sort by tag match count (more tags = more relevant), then by color count (fewer = purer pixel art)
      results.sort((a: any, b: any) => {
        const aTagScore = (a.tags || []).length;
        const bTagScore = (b.tags || []).length;
        if (bTagScore !== aTagScore) return bTagScore - aTagScore;
        return (a.colors || 999) - (b.colors || 999);
      });

      results = results.slice(0, maxResults);

      if (results.length === 0) {
        return textResult(`No sprites found matching tags: [${searchTags.join(", ")}] (${index.length} total indexed)`);
      }

      const summary = results.map((r: any) =>
        `[${r.width}x${r.height}] ${r.path} | tags: ${(r.tags||[]).join(",")} | colors: ${r.colors || "?"}`
      ).join("\n");

      return textResult(`${results.length} match(es) for [${searchTags.join(", ")}]:\n${summary}`);
    },
  );

}
