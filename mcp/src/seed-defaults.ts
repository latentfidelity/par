/**
 * PAR Seed Defaults — Initial skill templates seeded on first boot.
 */
import fs from "fs";
import path from "path";
import { META_DIR, writeJSON } from "./lib/storage.js";

export function seedDefaults() {
  const skillsDir = path.join(META_DIR, "skills");

  const defaults = [
    {
      id: "deploy-par",
      name: "Deploy PAR",
      description: "Deploy PAR changes to your server via rsync + docker compose",
      type: "knowledge",
      tags: ["deploy", "docker", "devops"],
      instructions: `# Deploy PAR

## Steps

1. **Sync files to the server** (excluding node_modules):
\`\`\`bash
rsync -avz --exclude='node_modules' ./par/ yourserver:/opt/par/
\`\`\`

2. **Rebuild and restart containers**:
\`\`\`bash
ssh yourserver 'cd /opt/par && docker compose up -d --build 2>&1 | tail -20'
\`\`\`

3. **Verify all services are healthy**:
\`\`\`bash
ssh yourserver 'docker ps --format "table {{.Names}}\\\\t{{.Status}}\\\\t{{.Ports}}"' && echo "---" && curl -s http://localhost:3100/health && echo && curl -s http://localhost:3200/health
\`\`\`

## Notes
- Your deployment server
- Meta storage persists at /opt/par/meta on the host
- Watchtower handles automatic image updates (daily)
`,
      script: null,
    },
    {
      id: "conversation-handoff",
      name: "Conversation Handoff",
      description: "How to persist context between AI conversations using the meta store",
      type: "knowledge",
      tags: ["workflow", "context", "meta"],
      instructions: `# Conversation Handoff

Use this skill to preserve important context when ending a conversation so the next conversation can pick up seamlessly.

## At End of Conversation

Store key decisions, progress, and next steps:

1. Use \`meta_store\` with key \`handoff/<project-id>\` to save:
   - What was accomplished
   - Key decisions made  
   - Current blockers
   - Immediate next steps
   - Any important file paths or references

2. If there are open tasks, use \`task_add\` to persist them.

## At Start of New Conversation

1. Use \`meta_retrieve\` with key \`handoff/<project-id>\` to load context
2. Use \`task_list\` with the project filter to see pending work
3. Use \`project_get\` to review project details
`,
      script: null,
    },
    {
      id: "project-onboard",
      name: "Project Onboarding",
      description: "Register a new project in the system with full tracking setup",
      type: "knowledge",
      tags: ["workflow", "setup", "projects"],
      instructions: `# Project Onboarding

When starting work on a new or existing project, register it in the system for cross-conversation tracking.

## Steps

1. **Register the project**
2. **Add initial tasks** for known work items
3. **Save any reusable patterns** discovered during setup
4. **Store initial handoff context** so the next conversation has context
`,
      script: null,
    },
    {
      id: "health-check",
      name: "Infrastructure Health Check",
      description: "Check the health of all PAR services",
      type: "execution",
      tags: ["devops", "monitoring", "health"],
      instructions: `# Infrastructure Health Check

Run this skill to verify all PAR services are operational.

The script checks:
- MCP Gateway (port 3100)
- Meta Store API (port 3200)
- Storage directory status
`,
      script: `#!/bin/bash
echo "=== PAR Health Check ==="
echo ""
echo "MCP Gateway:"
curl -s http://localhost:3100/health 2>/dev/null || echo "  ✗ UNREACHABLE"
echo ""
echo "Storage:"
echo "  Projects: $(ls -1 /data/meta/projects/*.json 2>/dev/null | wc -l) registered"
echo "  Tasks:    $(ls -1 /data/meta/tasks/*.json 2>/dev/null | wc -l) total"
echo ""
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
`,
    },
    {
      id: "experiment-runner",
      name: "Model Experiment Runner",
      description: "Standardized workflow for tracking and evaluating model training experiments",
      type: "knowledge",
      tags: ["ml", "models", "workflow"],
      instructions: `# Model Experiment Runner

When tasked with running a machine learning experiment or evaluating a model, enforce rigorous tracking.

## Steps

1. **Parameterize the run**: Ensure all hyperparameters are extracted into an explicit config file before starting.
2. **Execute the run**: Run the training process in a detached or logged process.
3. **Evaluate**: Execute a standardized evaluation script against holdout/adversarial datasets.
4. **Persist the results back to PAR**.
`,
      script: null,
    },
    {
      id: "deep-code-audit",
      name: "Deep Code Audit",
      description: "Automated gatekeeper process to guarantee SOTA code quality and security",
      type: "knowledge",
      tags: ["quality", "security", "workflow"],
      instructions: `# Deep Code Audit

When tasked with preparing a codebase for a SOTA release, run this comprehensive audit.

## Steps

1. **Static Analysis**: Run the industry-standard linter for the stack. Fix all warnings.
2. **Cyclomatic Complexity**: Use automated tools to enforce low cognitive limits on all functions.
3. **Memory & Performance**: Profile crucial execution paths.
4. **Security Scan**: Check dependencies for known CVEs. Check for SQL injection, proper API key obfuscation, and input validation.
5. **Report**: Generate an artifact summarizing the audit results and any remaining architectural debt.
`,
      script: null,
    },
  ];

  for (const skill of defaults) {
    const filePath = path.join(skillsDir, `${skill.id}.json`);
    if (!fs.existsSync(filePath)) {
      const toWrite = { ...skill, created: new Date().toISOString(), updated: new Date().toISOString() };
      writeJSON(filePath, toWrite);
      console.log(`  Seeded skill: ${skill.id}`);
    }
  }
}
