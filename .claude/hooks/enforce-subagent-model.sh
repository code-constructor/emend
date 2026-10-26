#!/usr/bin/env bash
# Blocks an Agent or Task call whose model differs from the model pinned in the agent's file.
# The agent is found by its `name:` frontmatter, then by file name. Fails closed on bad input.

fail() {
  echo "BLOCKED: enforce-subagent-model: $1" >&2
  exit 2
}

for tool in jq awk cat; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH, so sub-agent calls stay blocked."
done
INPUT=$(cat)
printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1 || fail "unreadable hook input."

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
SUBAGENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // ""')
REQUESTED_MODEL=$(printf '%s' "$INPUT" | jq -r '.tool_input.model // ""')
case "$TOOL_NAME" in Agent | Task) ;; *) exit 0 ;; esac
[ -n "$SUBAGENT" ] || exit 0

frontmatter_value() {
  awk -v key="$2" '
    { sub(/\r$/, "") }
    NR == 1 && $0 == "---" { frontmatter = 1; next }
    frontmatter && $0 == "---" { exit }
    frontmatter && index($0, key ":") == 1 {
      value = substr($0, length(key) + 2)
      gsub(/^[ \t]+|[ \t]+$/, "", value)
      gsub(/["'"'"']/, "", value)
      print value
      exit
    }
  ' "$1" 2>/dev/null
}

AGENTS_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/agents"
AGENT_FILE=""
for file in "$AGENTS_DIR"/*.md; do
  [ -f "$file" ] || continue
  if [ "$(frontmatter_value "$file" name)" = "$SUBAGENT" ]; then
    AGENT_FILE=$file
    break
  fi
done
if [ -z "$AGENT_FILE" ]; then
  case "$SUBAGENT" in */*) ;; *) [ -f "$AGENTS_DIR/${SUBAGENT}.md" ] && AGENT_FILE="$AGENTS_DIR/${SUBAGENT}.md" ;; esac
fi
# No project file: a built-in agent with no pin.
[ -n "$AGENT_FILE" ] || exit 0

PINNED_MODEL=$(frontmatter_value "$AGENT_FILE" model)
case "$PINNED_MODEL" in "" | inherit) exit 0 ;; esac
ENV_MODEL=${CLAUDE_CODE_SUBAGENT_MODEL:-}
if [ -n "$ENV_MODEL" ] && [ "$ENV_MODEL" != "$PINNED_MODEL" ]; then
  fail "CLAUDE_CODE_SUBAGENT_MODEL=$ENV_MODEL overrides '$SUBAGENT', which requires $PINNED_MODEL. Unset the override or set it to $PINNED_MODEL."
fi
if [ "$REQUESTED_MODEL" != "$PINNED_MODEL" ]; then
  fail "'$SUBAGENT' requires explicit model: \"$PINNED_MODEL\"; received '${REQUESTED_MODEL:-none}'."
fi
exit 0
