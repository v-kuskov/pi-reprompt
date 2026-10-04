# reprompt

A [pi](https://pi.dev) extension that lets the model restart its own session,
opening a fresh context with a prompt it writes.

A model works better from a clear prompt than from the conversation that led to
it. Once a plan is settled, or a plan step is done, the model can call
`reprompt` with a prompt describing the next step. The old context is compacted
into a checkpoint — guardrails included — and that prompt is appended below it as
the first user message of a new, empty context. It is `/new` in the model's
hands, with the part of the old context worth keeping carried across.

## Install

```bash
pi install git:github.com/v-kuskov/pi-reprompt
```

Or run it straight from a checkout, without installing:

```bash
pi -e ./path/to/pi-reprompt
```

## Use

The point is to let the model decide. Ask it to plan, and tell it to hand the
work to a clean context when the plan is ready:

> Plan how to add rate limiting to the API. When the plan is ready, use
> `reprompt` to start implementing it.

The model plans, then calls `reprompt` with the implementation step as its
argument. A checkpoint of the planning context — the plan, your constraints,
what is settled — is written first, and the model's prompt is appended below it.
Your session ends; a fresh one opens with that message, and the implementation
begins with a clean context instead of the whole planning conversation.

This pays off whenever the reasoning that produced a prompt is worth less than
the prompt itself, while the constraints around it still have to hold:

- **Work starts after planning.** The plan and your guardrails survive; the
  deliberation does not.
- **Each step of a multi-step plan.** One step per context, so attention stays
  on the step in front of it, and a constraint stated at the start is still in
  force at the end.
- **A long thread has drifted.** The model restates what matters and starts over.

## By hand

You can restart yourself, with or without the model's help:

```
/reprompt <prompt>
```

With no argument, `/reprompt` uses a prompt the model staged; if there is none,
it tells you there is nothing to restart with. A prompt you type yourself is
never mixed up with a staged one. Either way the context is compacted first, so
a hand-typed prompt also arrives below a checkpoint rather than alone.

## What the model passes

| Parameter | Description |
|---|---|
| `prompt` | The instruction that opens the new context, appended below the checkpoint of the one being left. Guardrails, history, and discoveries arrive in the checkpoint, so it states what to do next and what would count as done. |

## The checkpoint

A prompt the model writes for itself is a prompt it can also write its own
constraints out of. So the context being left is compacted first, by a second
model, into a checkpoint with a fixed shape:

```
## Task
## Guardrails
## Current State
## Done
## Next Task
## Critical Context
```

Guardrails are a section of their own rather than a line buried in prose,
because they are the part a restart must not lose — instructions from you, from
an `AGENTS.md`, or from a system prompt, quoted rather than paraphrased.

The model's `prompt` is appended **below** the checkpoint, outside the
compaction prompt. That order is the point: the model still decides what to do
next, but no longer decides what it is allowed to do. A compactor shown the
prompt would fold it into the checkpoint and reword it, which is exactly what
must not happen.

The new context's first user message therefore looks like:

```
<reprompt-checkpoint>
## Task
…
</reprompt-checkpoint>

<the model's prompt>
```

If the compaction fails — no model, a provider error, an unusable answer — you
are told why, and the restart goes ahead on the model's prompt alone. A restart
the model asked for is never stranded by a summary call.

### Choosing the model

The compactor is read from pi's own `settings.json`, under this extension's
key, `reprompt.model`:

```json
{ "reprompt": { "model": "routerai/deepseek/deepseek-v4.1-flash" } }
```

The extension owns the key: naming a model here affects nothing but this
extension's compaction. A project `.pi/settings.json` wins field by field. With
no key set, the session's own model compacts. A key that names an unknown or
unauthenticated model is reported and the session model is used instead, so a
stale setting cannot block a restart.

## Behavior

- The new context's **first user message** is the checkpoint of the context
  being left, followed by the model's prompt.
- The restart happens **after the current run ends**, so the model's reply
  explaining the handoff still reaches you and the transcript stays well-formed.
- A run you **abort** (Esc), that **fails**, or that was **cut off** before its
  last message was finalized does not restart the session. Its staged prompt is
  stale, so it is dropped.
- One staged prompt causes at most one restart.
- An empty prompt is rejected, and the session continues unchanged.
- If another extension has taken the `/reprompt` name, the restart cannot be
  addressed; you are told, and the prompt is not silently lost.
- If the new session cannot be sent the prompt — an auth or network failure at
  that moment — you are told, because the old context is already gone by then.

## How it works

pi lets an extension replace the session only from a command, not from inside a
run, because doing it mid-run deadlocks the runtime. So the tool stages the
prompt and returns; the extension hands it over at settlement, through a command
pi can dispatch. See [ADR 0001](docs/adr/0001-restart-at-settlement.md) for the
reasoning and [GLOSSARY.md](GLOSSARY.md) for the vocabulary.

Working on the extension? [AGENTS.md](AGENTS.md) covers the layout, the tests,
and how to verify a change end to end.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
