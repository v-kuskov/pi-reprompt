# ADR 0001: Restart at settlement, through an extension command

Status: accepted

## Context

The model should be able to restart its session with a prompt it writes itself,
so that finishing a plan or a plan step can start from a clean context instead
of the transcript that produced it.

pi offers two ways to reduce a context:

- `ctx.compact()` summarizes and **keeps** recent messages. The transcript
  survives in summary form.
- `ctx.newSession()` replaces the session outright. The new context begins
  empty.

`newSession()` is exposed only on `ExtensionCommandContext`, and pi documents
the reason: it is "command-only because calling these operations from lifecycle
handlers can deadlock the runtime." A tool handler and an event handler both get
a narrower context. So the model cannot call `newSession()` directly, and
neither can the event that follows the model's tool call.

## Decision

The `reprompt` tool stages the seed and returns. When the run settles, an
`agent_settled` handler dispatches an extension command by text, and the command
handler — which does have a command context — calls `newSession()` with the seed
as the replacement session's first user message.

The seed is claimed at settlement, before dispatch, and read by the handler from
extension state rather than carried as the command's argument. Dispatch by text
is how pi reaches a command, and a name that is not registered would be
delivered to the model as ordinary text instead, leaving the dispatch
unperformed.

## Why not compact

A compaction is a summary of the old context; a restart is a prompt written for
the new one. The point of the feature is that the model decides what the next
context contains, which a summarizer does not do. Compaction also keeps recent
messages, so the context is reduced, not clean.

## Consequences

- The restart happens after the run that asked for it, never during it, so the
transcript stays well-formed and the model's own explanation reaches the user.
- Dispatching from `agent_settled` is safe because pi defers a prompt raised
  while that event is being emitted until settlement has finished.
- pi requires a registered command name for the dispatch, so `/reprompt` appears
  in the user's slash-command list and is also usable by hand.
- Settlement follows an aborted or failed run too, so the handler reads the
  branch to confirm the run completed before acting. Otherwise pressing Esc would
  replace the session against the user's intent.

## Refinements found by review

Four failure paths were found after the first implementation and are now part of
the design.

**A shared command name has no address.** pi renames every registration of a
shared name to `reprompt:1`, `reprompt:2`, …, and matches a dispatch against the
renamed form exactly. A bare `/reprompt` dispatch therefore goes unanswered when
the name is taken — a second extension registering `reprompt` is enough — and the
text reaches the model as an ordinary message. The name is now read back from
`pi.getCommands()` and the restart is abandoned with a notification when it is
ambiguous. `src/seed.ts` (`dispatchName`) carries the rule.

**A typed argument did not discard the claim.** The handler used
`typed ?? takeClaimed() ?? args`; nullish coalescing never evaluated
`takeClaimed()` once `typed` was set, so a claim stranded by an earlier failure
survived any number of typed invocations and was later spent by an unrelated bare
one. The claim is now taken before selecting, so a typed prompt discards it.

**A throw lost the prompt in silence.** pi replaces the session before the seed
is sent, so a throw from `sendUserMessage` — auth, network — leaves the old
context already destroyed, the new session with no user message, and the prompt
spent. The handler notifies with the reason and rethrows, since pi reports a
handler throw as an extension error rather than propagating it.

**An unfinished run counted as completed.** The first check denied only
`aborted` and `error`, so `pending` — pi's marker for a message that was never
finalized — passed as success. The check now requires pi's own success partition:
`stop`, `length`, `toolUse`, `deferred`.
