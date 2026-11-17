#!/bin/bash
# Sourced by board-status.sh and listen-pending.sh, never run on its own: the one list of the prompts a UserPromptSubmit hook
# gets that you did not type (another session's message, a notice from the session subscription, a task notification, a
# system reminder, a subagent's hand-back). Add a new format here and both hooks follow.
# typed_by_you PROMPT: succeeds when PROMPT (leading space already trimmed) is one you typed.
typed_by_you() {
  case "$1" in
    "<cross-session-message"* | "<task-notification"* | "<agent-message"* | "<system-reminder"* | \
      "Another Claude session sent a message"* | "[Cross-session idle notice]"* | "[Subagent hand-back]"*)
      return 1
      ;;
  esac
  return 0
}
