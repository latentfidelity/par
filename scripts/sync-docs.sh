#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# sync-docs.sh — Reconcile docs/index.html with source of truth
# 
# Loss function: |visual_count - source_count| → 0
# 
# Reads tool registrations from mcp/src/tools/*.ts,
# patches docs/index.html counts, and validates the TOOLS array.
# Run before committing any tool changes.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$ROOT/mcp/src/tools"
DOCS="$ROOT/docs/index.html"
PAR_README="$ROOT/README.md"
ENGRAM_README="${ENGRAM_PATH:-$ROOT/../engram/README.md}"

# ─── 1. EXTRACT GROUND TRUTH FROM SOURCE ─────────────────────

# Count server.tool() calls (the source of truth)
SOURCE_COUNT=$(grep -c "server\.tool(" "$TOOLS_DIR"/*.ts 2>/dev/null \
  | awk -F: '{s+=$2} END {print s}')

# Extract tool IDs (first quoted string after server.tool()
SOURCE_TOOLS=$(grep -A1 "server\.tool(" "$TOOLS_DIR"/*.ts \
  | grep -oE '"[a-z_]+"' \
  | tr -d '"' \
  | sort -u)

# Filter out false positives (strings that aren't tool names)
# Real tool names match: word_word pattern and are registered tools
KNOWN_FALSE_POSITIVES="kv projects"
CLEAN_TOOLS=""
for t in $SOURCE_TOOLS; do
  skip=0
  for fp in $KNOWN_FALSE_POSITIVES; do
    [ "$t" = "$fp" ] && skip=1
  done
  [ $skip -eq 0 ] && CLEAN_TOOLS="$CLEAN_TOOLS $t"
done
CLEAN_COUNT=$(echo $CLEAN_TOOLS | wc -w | tr -d ' ')

echo "═══════════════════════════════════════"
echo "  PAR Docs Reconciliation"
echo "═══════════════════════════════════════"
echo ""
echo "  Source of truth:  $SOURCE_COUNT server.tool() calls"
echo "  Unique tool IDs:  $CLEAN_COUNT"
echo ""

# ─── 2. CHECK DOCS/INDEX.HTML ─────────────────────────────────

if [ -f "$DOCS" ]; then
  # Count tools in the JS TOOLS array
  DOCS_ARRAY_COUNT=$(grep -c "{ id:" "$DOCS" | head -1 || echo 0)
  # But this counts FLOW_NODES too. Count only in the TOOLS = [...] section
  DOCS_ARRAY_COUNT=$(sed -n '/^const TOOLS/,/^];/p' "$DOCS" | grep -c "{ id:" || echo 0)
  
  # Find hardcoded count references (extract from "NN MCP Tools" pattern)
  DOCS_COUNT_REFS=$(grep -oE '[0-9]+ MCP [Tt]ools' "$DOCS" | head -1 | grep -oE '[0-9]+' || echo "?")
  
  echo "  docs/index.html:"
  echo "    TOOLS array entries: $DOCS_ARRAY_COUNT"
  echo "    Displayed count:     $DOCS_COUNT_REFS"
  
  DOCS_DELTA=$((SOURCE_COUNT - DOCS_ARRAY_COUNT))
  if [ "$DOCS_DELTA" -ne 0 ]; then
    echo ""
    echo "  ⚠️  DRIFT DETECTED: docs TOOLS array has $DOCS_ARRAY_COUNT, source has $SOURCE_COUNT"
    echo ""
    
    # Find which tools are missing from docs
    DOCS_TOOLS=$(sed -n '/^const TOOLS/,/^];/p' "$DOCS" \
      | grep -oE "id: '[a-z_]+'" \
      | sed "s/id: '//;s/'$//" \
      | sort)
    
    echo "  Missing from docs:"
    for t in $CLEAN_TOOLS; do
      if ! echo "$DOCS_TOOLS" | grep -q "^${t}$"; then
        echo "    + $t"
      fi
    done
    
    echo "  Extra in docs (removed from source?):"
    for t in $DOCS_TOOLS; do
      if ! echo "$CLEAN_TOOLS" | grep -q "^${t}$"; then
        echo "    - $t"
      fi
    done
  else
    echo "    ✅ TOOLS array matches source"
  fi
  
  # ─── 3. PATCH COUNTS ─────────────────────────────────────────
  
  # Replace old count with new count in all known locations
  OLD_COUNT=$DOCS_COUNT_REFS
  if [ "$OLD_COUNT" != "$SOURCE_COUNT" ] && [ "$OLD_COUNT" != "?" ]; then
    echo ""
    echo "  Patching $OLD_COUNT → $SOURCE_COUNT in docs/index.html..."
    
    # Targeted replacements (only in tool-count contexts)
    sed -i '' "s/${OLD_COUNT} MCP Tools/${SOURCE_COUNT} MCP Tools/g" "$DOCS"
    sed -i '' "s/${OLD_COUNT} MCP tools/${SOURCE_COUNT} MCP tools/g" "$DOCS"
    sed -i '' "s/Tool Registry (${OLD_COUNT})/Tool Registry (${SOURCE_COUNT})/g" "$DOCS"
    sed -i '' "s/${OLD_COUNT} tools · Zod/${SOURCE_COUNT} tools · Zod/g" "$DOCS"
    sed -i '' "s/(${OLD_COUNT} tools)/(${SOURCE_COUNT} tools)/g" "$DOCS"
    
    echo "    ✅ docs/index.html patched"
  fi
else
  echo "  ⚠️  docs/index.html not found"
fi

# ─── 4. CHECK READMEs ──────────────────────────────────────────

echo ""
for readme_path in "$PAR_README" "$ENGRAM_README"; do
  readme_name=$(basename "$(dirname "$readme_path")")/README.md
  if [ -f "$readme_path" ]; then
    readme_count=$(grep -oE '[0-9]+ MCP [Tt]ools' "$readme_path" | head -1 | grep -oE '[0-9]+' || echo "?")
    if [ "$readme_count" = "$SOURCE_COUNT" ]; then
      echo "  ✅ $readme_name: $readme_count tools (correct)"
    elif [ "$readme_count" != "?" ]; then
      echo "  ⚠️  $readme_name: says $readme_count, should be $SOURCE_COUNT"
    fi
  fi
done

# ─── 5. SUMMARY ───────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════"

if [ "${DOCS_DELTA:-0}" -eq 0 ]; then
  echo "  ✅ All surfaces in sync ($SOURCE_COUNT tools)"
else
  echo "  ⚠️  TOOLS array needs $DOCS_DELTA entries added"
  echo "  Counts were patched but array must be updated manually"
  echo "  Add the missing tool entries to const TOOLS in docs/index.html"
fi

echo "═══════════════════════════════════════"
