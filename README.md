# reprompt

A [pi](https://pi.dev) extension that lets the model restart its own session,
opening a fresh context with a prompt it writes.

A model works better from a clear prompt than from the conversation that led to
it. Once a plan is settled, or a plan step is done, the model can call
`reprompt` with a self-contained prompt; that prompt becomes the first user
message of a new, empty context. It is `/new` in the model's hands.

## Install

```bash
pi install npm:pi-extension-reprompt
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

The model plans, then calls `reprompt` with the plan as its argument. Your
session ends; a fresh one opens with that plan as its first message, and the
implementation begins with a clean context instead of the whole planning
conversation.

This pays off whenever the reasoning that produced a prompt is worth less than
the prompt itself:

- **Work starts after planning.** The plan survives; the deliberation does not.
- **Each step of a multi-step plan.** One step per context, so attention stays
  on the step in front of it.
- **A long thread has drifted.** The model restates what matters and starts over.

## By hand

You can restart yourself, with or without the model's help:

```
/reprompt <prompt>
```

With no argument, `/reprompt` uses a prompt the model staged; if there is none,
it tells you there is nothing to restart with. A prompt you type yourself is
never mixed up with a staged one.

## What the model passes

| Parameter | Description |
|---|---|
| `prompt` | The first user message of the new context. It must stand alone — goal, constraints, what is already done, next action — because the context it replaces is gone. |

## Behavior

- The prompt becomes the **first user message** of the new context, after pi's
  system prompt and before anything else.
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
