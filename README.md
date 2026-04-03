# opencode-notifier

Run custom shell commands when OpenCode events fire.

## What it does

Hooks into OpenCode's event system and spawns a user-configured shell command for each meaningful event — fire-and-forget, no OS notification system involved. Your script gets event data via environment variables.

| Event | Trigger |
|---|---|
| `idle` | Session finishes (`session.idle` / `session.status{idle}`) |
| `error` | Session errors out (`session.error`) |
| `permission` | OpenCode needs permission (`permission.asked` / `permission.updated`) |
| `question` | OpenCode asks a question (`question.asked` / `tool.execute.before(question)`) |

## Installation

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "git+https://github.com/dgronskij/opencode-notifier.git"
  ]
}
```

OpenCode installs it automatically via Bun on startup.

## Configuration

Create `~/.config/opencode/dgronskiy-events-hook.jsonc`:

```jsonc
{
  // Set to true to also run commands for child/sub-sessions
  "notifyChildSessions": false,

  // Shell commands to run per event. Omit any key to skip that event.
  "commands": {
    "idle":       "~/scripts/on-idle.sh",
    "error":      "~/scripts/on-error.sh",
    "permission": "~/scripts/on-permission.sh",
    "question":   "~/scripts/on-question.sh"
  },

  // Suppress all hooks during these hours
  "quietHours": {
    "enabled": false,
    "start": "22:00",
    "end": "08:00"
  }
}
```

All keys are optional. Missing `commands` entries are silently skipped.

## Environment variables

Each command is invoked via `sh -c` and receives these environment variables:

| Variable | Present on | Description |
|---|---|---|
| `OPENCODE_NOTIFIER_EVENT` | all | Event type string |
| `OPENCODE_NOTIFIER_SESSION_ID` | `idle`, `error` | Session ID |
| `OPENCODE_NOTIFIER_SESSION_TITLE` | `idle` | Session title |
| `OPENCODE_NOTIFIER_ERROR` | `error` | Error message |
| `OPENCODE_NOTIFIER_PERMISSION_ID` | `permission` | Permission request ID |

Your existing `PATH` and environment are inherited, so commands work as if run from your shell.

## Example script

```bash
#!/usr/bin/env bash
# ~/.scripts/on-idle.sh

notify-send "OpenCode" "Task done: $OPENCODE_NOTIFIER_SESSION_TITLE"
# or: curl -s "https://ntfy.sh/mytopic" -d "$OPENCODE_NOTIFIER_SESSION_TITLE"
# or: tmux display-message "opencode idle"
```

## Notes

- Child sessions (sub-tasks spawned by the AI) are suppressed by default. Set `notifyChildSessions: true` to include them.
- Deduplication prevents the same event from firing twice within 1.5 seconds.
- `~` in command paths is expanded to your home directory.
