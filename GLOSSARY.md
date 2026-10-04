# Glossary

## Seed

The prompt that opens a replacement session: the first user message of the new
context. The model writes the prompt half of it, and it has to stand alone,
because the session it replaces is gone by the time it is read.

## Checkpoint

The compacted form of the context being left: task, guardrails, current state,
what is done, the next task, and critical context. A second model writes it, in a
shape this extension fixes. Guardrails are a section of their own because they
are the part a restart must not lose — a prompt the model writes for itself is a
prompt it could also write its own constraints out of.

## Guardrail

An instruction that must keep applying after a restart: something the user
asked for, a rule from an `AGENTS.md`, a security-relevant requirement, a
forbidden action, an approval gate. Checkpoints quote guardrails rather than
paraphrasing them, and they are never left for the model's own prompt to restate.

## Compaction prompt

The prompt sent to the compactor to produce a checkpoint. It carries the
conversation and never the model's prompt: a compactor shown the prompt would
fold it into the checkpoint and reword it. The prompt is appended to the
checkpoint afterwards, outside the compactor's control.

## Restart

Replacing the current session with a fresh one whose context begins with the
seed — the same effect as `/new` followed by the user typing the seed.

## Stage

For the model, to hand pi a seed for the next context without ending the current
one. The `reprompt` tool stages; settlement delivers.

## Settle

The end of a run, once pi will not continue on its own. `agent_settled` is the
event that reports it. A restart is delivered at settlement so that it happens
after the run that asked for it, never during it.

## Claim

A staged seed taken out of waiting at settlement, on its way to the command that
will restart the session. The seed travels as a claim rather than as the
command's argument, because that argument is what the user typed. Claiming
discards any claim left by an earlier run, so one seed is delivered once.

## Take

To spend a claim, leaving none behind.

## Dispatch name

The name a command is actually addressed by. pi renames every registration of a
shared command name (`reprompt:1`, `reprompt:2`, …), so the name is read back
from pi rather than assumed. When the name is shared, there is no single
address, and the restart is reported as undeliverable rather than attempted.

## Completed run

A run that ended on its own terms — not aborted by the user, not failed, not cut
off before its last message was finalized. Only a completed run's seed opens a
replacement session; a stale seed is dropped.
