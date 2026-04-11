/**
 * Registry tools: project_*, task_*, snippet_*, skill_*, dataset_*
 */
import fs from "fs";
import path from "path";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_DIR, readJSON, writeJSON, listJSON, textResult, errorResult, errorMessage } from "../lib/storage.js";

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
  // │  SKILL INGESTION                                        │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "skill_ingest",
    "Ingest source code into the skill library. Accepts any language — HTML/CSS/JS, Python, shell scripts, config files, etc. Auto-detects tech stack, computes complexity, checks for duplicates via embedding similarity, classifies into category, and writes a structured SKILL.md + source.md.",
    {
      name: z.string().describe("Kebab-case skill name (e.g. 'liquid-metal-button', 'csv-parser', 'docker-healthcheck')"),
      sources: z.record(z.string()).describe("Source code keyed by language/file type. E.g. {\"html\": \"...\", \"css\": \"...\", \"js\": \"...\"} or {\"python\": \"...\", \"bash\": \"...\", \"yaml\": \"...\"}"),
      source_url: z.string().optional().describe("Original source URL (e.g. CodePen link, GitHub gist, blog post)"),
      category: z.enum(["effect", "component", "template", "tool", "script", "pipeline", "config"]).optional()
        .describe("Override auto-classification (default: auto-detect from code)"),
      duplicate_threshold: z.number().optional()
        .describe("Cosine similarity threshold for duplicate detection (default 0.85)"),
    },
    async ({ name, sources, source_url, category, duplicate_threshold }) => {
      const allSource = Object.values(sources).join("\n");
      if (!allSource.trim()) return errorResult("Sources object is empty — provide at least one language key with code.");
      const sourceKeys = Object.keys(sources);

      // ── Tech stack detection (multi-domain, regex-based) ──
      const techPatterns: Array<[RegExp, string]> = [
        // Web / front-end
        [/THREE\.|three\.js|three\.module/i, "three-js"],
        [/gl\.create|WebGLRenderingContext|getContext\(['"]webgl/i, "webgl"],
        [/gl_FragColor|gl_Position|precision\s+(high|medium|low)p/i, "glsl"],
        [/gsap\.|ScrollTrigger|TweenMax/i, "gsap"],
        [/canvas\.getContext\(['"]2d['"]\)|CanvasRenderingContext2D/i, "canvas-2d"],
        [/navigator\.gpu|GPUDevice/i, "webgpu"],
        [/backdrop-filter/i, "backdrop-filter"],
        [/@keyframes\s/i, "css-animation"],
        [/<svg[\s>]|SVGElement/i, "svg"],
        [/AudioContext|Web\s*Audio/i, "web-audio"],
        [/CSS\.registerProperty/i, "css-houdini"],
        [/import\s.*from\s+['"]react/i, "react"],
        [/ShaderMaterial|RawShaderMaterial/i, "three-shader"],
        [/requestAnimationFrame/i, "animation-loop"],
        // Python
        [/import\s+(torch|tensorflow|keras)/i, "ml-framework"],
        [/import\s+(pandas|numpy|scipy)/i, "data-science"],
        [/import\s+(flask|fastapi|django)/i, "python-web"],
        [/import\s+(PIL|pillow|cv2)/i, "image-processing"],
        [/import\s+(asyncio|aiohttp)/i, "async-python"],
        [/def\s+\w+|class\s+\w+/i, "python"],
        // Shell / DevOps
        [/docker\s+(compose|build|run)|Dockerfile/i, "docker"],
        [/kubectl|helm\s+/i, "kubernetes"],
        [/rsync|scp|ssh\s+/i, "remote-ops"],
        [/cron|crontab|systemctl/i, "system-admin"],
        [/#!\/bin\/(ba)?sh|#!\/usr\/bin\/env\s+bash/i, "bash"],
        // Rust / Go / Systems
        [/fn\s+\w+|impl\s+\w+|use\s+std::/i, "rust"],
        [/func\s+\w+|package\s+main|import\s+\(/i, "go"],
        // Config / Data
        [/apiVersion:|kind:\s+Deployment/i, "kubernetes-manifest"],
        [/\[tool\.poetry\]|\[project\]/i, "pyproject"],
        [/version:\s+['"]?\d+\.\d+/i, "config"],
      ];

      const detectedTech: string[] = [];
      for (const [pattern, tag] of techPatterns) {
        if (pattern.test(allSource)) detectedTech.push(tag);
      }

      // Detect primary domain from source keys
      const hasWeb = sourceKeys.some(k => ["html", "css", "js", "javascript", "tsx", "jsx"].includes(k.toLowerCase()));
      const hasPython = sourceKeys.some(k => ["python", "py"].includes(k.toLowerCase()));
      const hasShell = sourceKeys.some(k => ["bash", "sh", "shell", "zsh"].includes(k.toLowerCase()));

      if (hasWeb && !sources.js?.trim() && !allSource.match(/<script/i)) detectedTech.push("css-only");
      if (hasPython) detectedTech.push("python");
      if (hasShell) detectedTech.push("shell");

      // ── Complexity computation ──
      const totalLines = allSource.split("\n").length;
      const complexity = totalLines < 100 ? "light" : totalLines <= 500 ? "medium" : "heavy";

      // ── Auto-classification ──
      let finalCategory = category;
      if (!finalCategory) {
        if (hasShell || detectedTech.includes("bash") || detectedTech.includes("docker")) {
          finalCategory = "script";
        } else if (detectedTech.includes("ml-framework") || detectedTech.includes("data-science")) {
          finalCategory = "pipeline";
        } else if (detectedTech.some(t => ["kubernetes-manifest", "pyproject", "config"].includes(t))) {
          finalCategory = "config";
        } else if (detectedTech.some(t => ["webgl", "glsl", "three-js", "gsap", "canvas-2d", "css-animation", "three-shader"].includes(t))) {
          finalCategory = "effect";
        } else if (hasWeb && /<(form|button|input|select|nav|card|modal|tooltip)/i.test(sources.html || "")) {
          finalCategory = "component";
        } else if (hasWeb && /<(header|main|footer|section|article)/i.test(sources.html || "") && totalLines > 200) {
          finalCategory = "template";
        } else {
          finalCategory = "tool";
        }
      }

      const skillId = `${finalCategory}-${name}`;

      // ── Duplicate detection via embedding ──
      const threshold = duplicate_threshold || 0.85;
      const description = `${skillId}: ${detectedTech.join(", ")} ${complexity} ${totalLines} lines`;
      let duplicateWarning: string | null = null;

      try {
        const { embed: embedFn, cosineSimilarity: cosSim } = await import("../lib/embedder.js");
        const newVec = await embedFn(description);

        const skillsDir = path.join(META_DIR, "skills");
        const existingSkills = listJSON(skillsDir);
        let maxSim = 0;
        let mostSimilar = "";

        for (const skill of existingSkills) {
          if (skill.embedding) {
            const sim = cosSim(newVec, skill.embedding);
            if (sim > maxSim) { maxSim = sim; mostSimilar = skill.id; }
          } else if (skill.description) {
            const skillVec = await embedFn(skill.description);
            const sim = cosSim(newVec, skillVec);
            if (sim > maxSim) { maxSim = sim; mostSimilar = skill.id; }
          }
        }

        if (maxSim >= threshold) {
          duplicateWarning = `⚠️ Potential duplicate: ${mostSimilar} (similarity: ${maxSim.toFixed(3)}). Proceeding anyway — review recommended.`;
        }
      } catch {
        // Embedding not available, skip duplicate check
      }

      // ── Write skill directory ──
      const libRoots = [
        path.join(META_DIR, "..", ".agents", "skills", "library"),
        path.join(META_DIR, "..", "agents", "skills", "library"),
      ];
      let libRoot = libRoots.find(p => fs.existsSync(p));
      if (!libRoot) {
        libRoot = libRoots[0];
        fs.mkdirSync(libRoot, { recursive: true });
      }

      const skillDir = path.join(libRoot, skillId);
      const refsDir = path.join(skillDir, "references");
      fs.mkdirSync(refsDir, { recursive: true });

      // Write source.md — generic, keyed by language
      const sourceParts: string[] = [`# Source: ${name}\n<!-- Source: ${source_url || "manual"} -->\n`];
      for (const [lang, code] of Object.entries(sources)) {
        if (code.trim()) {
          sourceParts.push(`## ${lang.charAt(0).toUpperCase() + lang.slice(1)}\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`);
        }
      }
      fs.writeFileSync(path.join(refsDir, "source.md"), sourceParts.join("\n"));

      // Write stub SKILL.md
      const techList = detectedTech.join(", ") || sourceKeys.join(", ");
      const skillMd = [
        "---",
        `name: ${skillId}`,
        `description: "${skillId}. Built with ${techList}."`,
        "quality:",
        "  self_contained: 0",
        "  code_clarity: 0",
        "  reusability: 0",
        "  effectiveness: 0",
        "  novelty: 0",
        "  total: 0/25",
        "---",
        "",
        `# ${name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}`,
        "",
        `## Technologies`,
        techList,
        "",
        `## Complexity`,
        `${complexity} (${totalLines} lines)`,
        "",
        "## Source Reference",
        "See `references/source.md` for the complete original implementation.",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);

      // ── Register in MCP skill registry ──
      const registryPath = path.join(META_DIR, "skills", `${skillId}.json`);
      const skillEntry = {
        id: skillId,
        name: name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        description,
        type: "knowledge" as const,
        tags: [finalCategory, ...detectedTech, complexity],
        instructions: `Stored in library at ${skillDir}. Read SKILL.md for usage.`,
        script: null,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      writeJSON(registryPath, skillEntry);

      return textResult({
        id: skillId,
        category: finalCategory,
        domain: hasWeb ? "web" : hasPython ? "python" : hasShell ? "shell" : "general",
        tech: detectedTech,
        complexity,
        total_lines: totalLines,
        source_languages: sourceKeys,
        path: skillDir,
        duplicate_warning: duplicateWarning,
        status: "ingested — SKILL.md needs enrichment (run skill_score then add description/customization)",
      });
    },
  );

  server.tool(
    "skill_score",
    "Score any skill on the 5-dimension quality rubric. Updates the quality block in SKILL.md frontmatter and the registry entry. Gate: 15/25 minimum to accept.",
    {
      id: z.string().describe("Skill ID (e.g. 'effect-liquid-metal-button', 'script-docker-healthcheck')"),
      self_contained: z.number().min(1).max(5).describe("1-5: Does it run standalone with minimal setup?"),
      code_clarity: z.number().min(1).max(5).describe("1-5: Is the code readable and well-structured?"),
      reusability: z.number().min(1).max(5).describe("1-5: Can it be dropped into another project easily?"),
      effectiveness: z.number().min(1).max(5).describe("1-5: How well does it accomplish its purpose?"),
      novelty: z.number().min(1).max(5).describe("1-5: Is this a unique pattern in the library?"),
    },
    async ({ id, self_contained, code_clarity, reusability, effectiveness, novelty }) => {
      const total = self_contained + code_clarity + reusability + effectiveness + novelty;
      const passed = total >= 15;

      // Update SKILL.md if it exists
      const libRoots = [
        path.join(META_DIR, "..", ".agents", "skills", "library"),
        path.join(META_DIR, "..", "agents", "skills", "library"),
      ];
      const libRoot = libRoots.find(p => fs.existsSync(p));

      if (libRoot) {
        const skillMdPath = path.join(libRoot, id, "SKILL.md");
        if (fs.existsSync(skillMdPath)) {
          let content = fs.readFileSync(skillMdPath, "utf-8");
          const qualityBlock = [
            "quality:",
            `  self_contained: ${self_contained}`,
            `  code_clarity: ${code_clarity}`,
            `  reusability: ${reusability}`,
            `  effectiveness: ${effectiveness}`,
            `  novelty: ${novelty}`,
            `  total: ${total}/25`,
          ].join("\n");

          if (content.includes("quality:")) {
            content = content.replace(
              /quality:[\s\S]*?total:\s*\d+\/25/m,
              qualityBlock,
            );
          } else {
            content = content.replace(/^---\s*$/m, `${qualityBlock}\n---`);
          }
          fs.writeFileSync(skillMdPath, content);
        }
      }

      // Update registry entry
      const registryPath = path.join(META_DIR, "skills", `${id}.json`);
      const existing = readJSON(registryPath);
      if (existing) {
        existing.quality = { self_contained, code_clarity, reusability, effectiveness, novelty, total };
        existing.updated = new Date().toISOString();
        writeJSON(registryPath, existing);
      }

      return textResult({
        id,
        quality: { self_contained, code_clarity, reusability, effectiveness, novelty, total: `${total}/25` },
        gate: passed ? "✅ PASSED (≥15)" : "❌ BELOW THRESHOLD (<15)",
        action: passed ? "Skill accepted — enrich SKILL.md with description, customization table, and usage pattern" : "Skill below quality gate — consider removing or improving",
      });
    },
  );

  // ┌─────────────────────────────────────────────────────────┐
  // │  SKILL ENRICHMENT (server-side analysis)                 │
  // └─────────────────────────────────────────────────────────┘

  server.tool(
    "skill_enrich",
    "Analyze a skill's source code and generate an enriched SKILL.md. Reads references/source.md, extracts dependencies, configurable properties, mount pattern, and key APIs. Writes the enriched SKILL.md in place. Use to batch-upgrade thin skills without reading source yourself.",
    {
      id: z.string().describe("Skill ID (directory name, e.g. 'effect-webgl-smoke')"),
      description: z.string().optional().describe("Optional one-line description override (default: auto-generated from analysis)"),
      dry_run: z.boolean().optional().describe("If true, return the analysis without writing SKILL.md"),
    },
    async ({ id, description: descOverride, dry_run }) => {
      // Locate skill in library
      const SKILLS_DIR = process.env.SKILLS_DIR || "/data/skills";
      const skillDir = path.join(SKILLS_DIR, id);
      if (!fs.existsSync(skillDir)) return errorResult(`Skill not found: ${id} (checked ${SKILLS_DIR})`);

      // Read source
      const sourcePath = path.join(skillDir, "references", "source.md");
      if (!fs.existsSync(sourcePath)) return errorResult(`No source.md found for ${id}`);
      const source = fs.readFileSync(sourcePath, "utf-8");
      const lines = source.split("\n");

      // ── Extract CDN dependencies ──
      const cdnPattern = /(?:src|href)=["']?(https?:\/\/[^"'\s>]+(?:\.js|\.css|\.min\.js|\.min\.css)[^"'\s>]*)["']?/gi;
      const cdns: string[] = [];
      let m;
      while ((m = cdnPattern.exec(source)) !== null) {
        const url = m[1];
        if (!cdns.includes(url) && !url.includes("codepenassets") && !url.includes("normalize")) {
          cdns.push(url);
        }
      }

      // ── Extract CSS custom properties (only from <style> blocks) ──
      const cssVars: { name: string; default_value: string }[] = [];
      const styleBlocks = source.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (styleBlocks) {
        const cssContent = styleBlocks.join("\n");
        const cssVarPattern = /--([a-zA-Z0-9-]+)\s*:\s*([^;]{1,60});/g;
        const seen = new Set<string>();
        while ((m = cssVarPattern.exec(cssContent)) !== null) {
          const varName = `--${m[1]}`;
          if (cssVars.length < 15 && !seen.has(varName)) {
            seen.add(varName);
            cssVars.push({ name: varName, default_value: m[2].trim().slice(0, 40) });
          }
        }
      }

      // ── Extract key JS patterns ──
      const jsPatterns: string[] = [];
      const canvasMatch = source.match(/getContext\(['"]([^'"]+)['"]\)/);
      if (canvasMatch) jsPatterns.push(`Canvas ${canvasMatch[1]}`);
      if (/requestAnimationFrame/i.test(source)) jsPatterns.push("Animation loop (rAF)");
      if (/addEventListener/i.test(source)) jsPatterns.push("Event listeners");
      if (/class\s+\w+/i.test(source)) jsPatterns.push("Class-based");
      if (/new THREE\./i.test(source)) jsPatterns.push("Three.js scene");
      if (/gl_FragColor|precision\s+\w+\s+float/i.test(source)) jsPatterns.push("GLSL shaders");
      if (/gsap\./i.test(source)) jsPatterns.push("GSAP animations");
      if (/IntersectionObserver/i.test(source)) jsPatterns.push("Scroll detection");
      if (/fetch\(|XMLHttpRequest/i.test(source)) jsPatterns.push("Network requests");
      if (/ResizeObserver/i.test(source)) jsPatterns.push("Responsive resize");

      // ── Detect tech stack (reuse ingestion patterns) ──
      const techPatterns: [RegExp, string][] = [
        [/THREE\.|three\.js|from\s+['"]three['"]/i, "three-js"],
        [/gl\.create|WebGLRenderingContext|getContext\(['"]webgl/i, "webgl"],
        [/gl_FragColor|precision\s+\w+\s+float/i, "glsl"],
        [/gsap\.|ScrollTrigger/i, "gsap"],
        [/canvas\.getContext\(['"]2d['"]\)/i, "canvas-2d"],
        [/@keyframes/i, "css-animation"],
        [/backdrop-filter/i, "backdrop-filter"],
        [/<svg|SVGElement/i, "svg"],
        [/AudioContext|Web Audio/i, "web-audio"],
        [/React\.|createElement|useState/i, "react"],
      ];
      const tech: string[] = [];
      for (const [rx, tag] of techPatterns) {
        if (rx.test(source) && !tech.includes(tag)) tech.push(tag);
      }

      // ── Extract mount pattern (first HTML body content, simplified) ──
      const htmlMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      let mountSnippet = "";
      if (htmlMatch) {
        const body = htmlMatch[1]
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<link[^>]*>/gi, "")
          .trim();
        const bodyLines = body.split("\n").map(l => l.trim()).filter(Boolean);
        mountSnippet = bodyLines.slice(0, 15).join("\n");
      }

      // ── Compute complexity ──
      const totalLines = lines.length;
      const complexity = totalLines < 100 ? "light" : totalLines < 500 ? "medium" : "heavy";

      // ── Determine category from name ──
      const category = id.startsWith("effect-") ? "effect"
        : id.startsWith("component-") ? "component"
        : id.startsWith("template-") ? "template"
        : id.startsWith("tool-") ? "tool"
        : id.startsWith("script-") ? "script"
        : "effect";

      // ── Build description ──
      const techList = tech.length > 0 ? tech.join(", ") : "HTML, CSS, JS";
      const autoDesc = descOverride || `${id.replace(/^(effect|component|template|tool|script)-/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}. Built with ${techList}.`;

      // ── Read existing quality block if present ──
      const existingSkill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
      const qualityMatch = existingSkill.match(/quality:\n([\s\S]*?)---/);
      let qualityBlock = "";
      if (qualityMatch) qualityBlock = `quality:\n${qualityMatch[1]}`;

      // ── Generate enriched SKILL.md ──
      const enriched = [
        `---`,
        `name: ${id}`,
        `description: "${autoDesc}"`,
        ...(qualityBlock ? [qualityBlock.trim()] : []),
        `---`,
        ``,
        `# ${id.replace(/^(effect|component|template|tool|script)-/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`,
        ``,
        autoDesc,
        ``,
        `## When to Use`,
        ``,
        `- ${category === "effect" ? "Background animation or visual accent" : category === "component" ? "Interactive UI element" : category === "template" ? "Full page layout" : "Utility or tool"}`,
        `- Projects requiring ${techList}`,
        `- ${complexity === "light" ? "Quick integration, minimal overhead" : complexity === "medium" ? "Feature-level integration" : "Full-page or complex integration"}`,
        ``,
        `## Core Technique`,
        ``,
        ...(jsPatterns.length > 0 ? [`Uses ${jsPatterns.slice(0, 3).join(", ")}. ${complexity === "heavy" ? "Complex multi-system implementation." : "Straightforward implementation pattern."}`] : [`Standard ${techList} implementation.`]),
        ``,
        ...(jsPatterns.length > 0 ? [
          `### Key APIs`,
          ``,
          `| API/Pattern | Purpose |`,
          `|---|---|`,
          ...jsPatterns.slice(0, 8).map(p => `| ${p} | Core mechanism |`),
          ``,
        ] : []),
        ...(mountSnippet ? [
          `## Mount Pattern`,
          ``,
          "```html",
          mountSnippet,
          "```",
          ``,
        ] : []),
        ...(cssVars.length > 0 ? [
          `## Customization`,
          ``,
          `| Property | Default | Description |`,
          `|---|---|---|`,
          ...cssVars.slice(0, 10).map(v => `| \`${v.name}\` | \`${v.default_value}\` | CSS custom property |`),
          ``,
        ] : []),
        `## Dependencies`,
        ``,
        ...(cdns.length > 0 ? cdns.map(u => `- ${u}`) : [`- None (vanilla ${techList})`]),
        ``,
        `## Metrics`,
        ``,
        `- **Lines:** ${totalLines}`,
        `- **Complexity:** ${complexity}`,
        `- **Tech:** ${techList}`,
        ``,
        `## Source Reference`,
        ``,
        `See \`references/source.md\` for the complete original implementation.`,
      ].join("\n");

      if (dry_run) {
        return textResult({
          id,
          analysis: {
            tech,
            complexity,
            total_lines: totalLines,
            dependencies: cdns,
            css_vars: cssVars.length,
            js_patterns: jsPatterns,
            mount_pattern: mountSnippet ? "extracted" : "none",
            category,
          },
          preview_lines: enriched.split("\n").length,
        });
      }

      // Write enriched SKILL.md
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), enriched);

      return textResult({
        id,
        enriched: true,
        lines_before: existingSkill.split("\n").length,
        lines_after: enriched.split("\n").length,
        tech,
        complexity,
        dependencies: cdns.length,
        css_vars: cssVars.length,
        js_patterns: jsPatterns.length,
        mount_pattern: mountSnippet ? true : false,
      });
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
