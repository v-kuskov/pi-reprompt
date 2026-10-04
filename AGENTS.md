# AGENTS.md

Guidance for agents working in this repository.

## What this is

A pi extension. The model gets a `reprompt` tool; calling it restarts the
session with a prompt the model wrote, as the first user message of the new
context. `README.md` describes the behavior; `GLOSSARY.md` defines the
vocabulary (seed, stage, settle, claim, take, dispatch name, restart);
`docs/adr/0001-restart-at-settlement.md` records why the restart is delivered at
settlement through an extension command.

## Layout

| Path | Holds |
|---|---|
| `src/seed.ts` | The restart policy: when a run completed, how a seed is staged and claimed, which prompt an invocation uses, and which name to dispatch by. No pi imports, so it is directly testable. |
| `src/compact.ts` | The compaction policy: the prompt the compactor is given, how a checkpoint is read back, how it is composed with the model's prompt to form the seed, and which model to compact with. No pi imports, so it is directly testable. |
| `src/index.ts` | The extension: the `reprompt` tool, the `/reprompt` command, the `agent_settled` handler that delivers one through the other, and the model call that produces the checkpoint. Thin — the decisions live in `src/seed.ts` and `src/compact.ts`. |
| `test/seed.test.ts` | Tests for the restart policy. |
| `test/compact.test.ts` | Tests for the compaction policy. |

## Commands

```bash
npm test        # node --test "test/**/*.test.ts"
npm run check   # tsc --noEmit
```

## Verifying a change end to end

The policy is unit-tested, but the delivery path only exists inside pi. To
exercise it, run pi against the extension and watch the new session's first user
message:

```bash
pi -p --extension ./src/index.ts --model 'routerai/deepseek/deepseek-v4.1-flash' \
  --tools reprompt \
  "Call reprompt now with a prompt that says: 'Reply with exactly the word BANANA and nothing else.' Then stop."
```

`BANANA` in the output means the tool ran, the run settled, the session was
replaced, and the staged prompt opened the new context. The manual path:

```bash
pi -p --extension ./src/index.ts --tools '' "/reprompt Reply with exactly the word KIWI and nothing else."
```

The **abort guard** needs a tool that stages a prompt and then aborts the run,
because an aborted run still settles. Register one — `pi.registerTool` with an
`execute` that calls `ctx.executeTool("reprompt", { prompt: "…" })` and then
`ctx.abort()` — alongside `reprompt`, and confirm the session is *not* replaced:
only one user message, and no reply from the staged prompt.

Session files are JSONL under `~/.pi/agent/sessions/--<cwd-slug>--/`, if you want
to inspect a replacement session's branch directly.

Use `--extension`, not `--no-extensions`: the latter also drops the provider
package that resolves `routerai` models.

## Constraints that shape the design

Verified against pi's source. Changing the design without accounting for them
breaks delivery in ways the unit tests cannot catch.

- **Session replacement is command-only.** `newSession()` exists on
  `ExtensionCommandContext` and nowhere else; calling it from a tool or a
  lifecycle handler deadlocks the runtime. That is why the tool stages instead
  of restarting, and why settlement dispatches a command. Compaction runs in the
  command handler for the same reason: it is the last moment the context being
  left still exists.
- **A prompt raised during `agent_settled` is deferred** until settlement
  finishes. This is what makes dispatching from the handler safe.
- **Dispatch requires a registered command name, matched exactly.**
  `sendUserMessage(text, { expandPromptTemplates: true })` reaches a command only
  when the text starts with `/` and the name matches; otherwise the text reaches
  the model as an ordinary message and the command never runs. pi renames every
  registration of a shared name to `reprompt:1`, `reprompt:2`, …, so the name is
  read back from `pi.getCommands()` and the dispatch is abandoned when it is
  ambiguous.
- **Settlement also follows an aborted, failed, or unfinished run.**
  `agent_settled` is emitted in a `finally`, so the handler checks the run's
  outcome before acting, or Esc would replace the session.
- **pi replaces the session before the prompt is sent.** A throw from
  `sendUserMessage` therefore leaves the prompt nowhere to go. `newSession` runs
  `teardownCurrent` first, so the old context is already gone when the seed is
  delivered.
- **A command handler that throws is reported, not propagated** — pi's
  `_tryExecuteExtensionCommand` catches it and emits an extension error. Anything
  the user needs to know must be said with `ctx.ui.notify` before throwing.
- **Only the tool `description` always reaches the model.** pi builds the
  `promptSnippet` and `promptGuidelines` entries into the tools and rules
  sections of its *default* prompt; a custom system prompt (`~/.pi/agent/SYSTEM.md`
  or a project `.pi/SYSTEM.md`) skips both sections entirely. So the description
  must carry anything the model has to know to call the tool correctly, and the
  snippet and guidelines are refinements for the default prompt only.
- **Unknown top-level settings keys survive a load.** pi's `Settings` interface
  has no `reprompt` key, but a project or agent-directory `settings.json` is not
  filtered, so `reprompt.model` reads back intact (verified with a probe against
  `SettingsManager`). That is where the compactor's model is read from — this
  extension's own key, so naming a model there affects nothing else.

## Conventions

- ESM TypeScript, `.ts` extensions in relative imports, tabs for indentation.
- Comments explain why, not what, and only where the reason is not visible in
  the code — the pi constraints above are the common case.
- Keep the policy in `src/seed.ts` free of pi imports, so it stays testable. If
  you need a pi type, take the structural shape instead (see `TranscriptEntry`).
