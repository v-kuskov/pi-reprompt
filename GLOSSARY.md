# Glossary

## Seed

The prompt that opens a replacement session: the first user message of the new
context. The model writes it, and it has to stand alone, because the session it
replaces is gone by the time it is read.

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
