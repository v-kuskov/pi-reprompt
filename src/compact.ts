/**
 * reprompt — the compaction policy.
 *
 * A restart replaces the session, so whatever the model needs to continue has
 * to survive in the prompt that opens the replacement. The model writes that
 * prompt, but a model that wrote its own context would also be free to drop the
 * guardrails it was given. So the old context is compacted into a checkpoint by
 * a second model, in a shape this module fixes, and only then is the model's
 * prompt appended.
 *
 * The two halves stay apart: the checkpoint is what the compactor produced, and
 * the prompt is the model's own message to the next context. The prompt never
 * enters the compaction prompt, because a compactor shown it would fold it into
 * the checkpoint and reword it — the one thing it must not do.
 *
 * This module imports no pi runtime, so the policy is testable without starting
 * a session. The model call itself lives in `./index.ts`.
 */

/** Delimiters the checkpoint is asked for in, and read back by. */
export const CHECKPOINT_OPEN = "<reprompt-checkpoint>";
export const CHECKPOINT_CLOSE = "</reprompt-checkpoint>";

/**
 * Settings key holding the compactor's model, as `reprompt.model`.
 *
 * This extension owns the key: it names the model used to compact a context
 * that is about to be restarted, and nothing else reads it. It is read from
 * pi's own settings file rather than a file of this extension's, so a project
 * can override it in one place. pi's `Settings` type has no such field, but
 * unknown top-level keys survive a load, which is what makes the key readable.
 */
export const SETTINGS_KEY = "reprompt";

/**
 * The sections a checkpoint carries, in the order it is asked for.
 *
 * Guardrails are a section of their own rather than a line under constraints:
 * they are the instructions a restart must not lose, and a checkpoint that
 * buries them among prose is how a guardrail silently stops applying.
 */
export const CHECKPOINT_SECTIONS: readonly string[] = [
	"Task",
	"Guardrails",
	"Current State",
	"Done",
	"Next Task",
	"Critical Context",
];

/** The model to compact with, absent when nothing is configured. */
export interface CompactSettings {
	/** Compactor as `provider/model`. Absent means the session model. */
	model?: string;
}

/**
 * The prompt that turns a conversation into a checkpoint.
 *
 * Section order, wording, and the tags are fixed here and read back by
 * `checkpointFrom`, so the two cannot drift.
 *
 * The conversation is carried ahead of the instruction, so the model reads what
 * it is summarizing before what it is being asked for.
 */
export function buildCompactionPrompt(conversation: string): string {
	const sections = CHECKPOINT_SECTIONS.map((section) => `## ${section}\n<${SECTION_HINTS[section]}>`).join("\n");

	return `<conversation>
${conversation}
</conversation>

The messages above are the context that is ending. Write the checkpoint that opens the context which continues it.

Answer with exactly one ${CHECKPOINT_OPEN} block and nothing else:

${CHECKPOINT_OPEN}
${sections}
${CHECKPOINT_CLOSE}

Preserve exact file paths, function names, error messages, and the wording of every guardrail. Quote a guardrail rather than describing it. Omit a section only when the conversation holds nothing for it.`;
}

/** What each section is for, keyed by its heading. */
const SECTION_HINTS: Record<string, string> = {
	Task: "what is being worked on and the goal it serves",
	Guardrails:
		"constraints that must keep applying after the restart: instructions from the user, project files, or a system prompt; security-relevant requirements; forbidden actions; approval gates",
	"Current State": "where the work stands — what runs, what fails, what is half-finished",
	Done: "what is finished, and the evidence that verified it",
	"Next Task": "the single next action, and the file and symbol it starts from",
	"Critical Context": "exact file paths, function names, error messages, and decisions with their reasons",
};

/**
 * Read the checkpoint out of the compactor's answer.
 *
 * A missing block falls back to the whole answer: a compactor that wrote the
 * sections without the tags still produced a usable checkpoint, and discarding
 * it would spend the restart with nothing to show for the model call. An answer
 * with no text at all yields undefined, which the caller reads as "no
 * checkpoint" and restarts on the model's prompt alone.
 *
 * An opening tag with no closing one is a token-limited answer rather than a
 * missing block, so the body after it is kept — including the tag would put a
 * stray opener inside the seed, where it reads as part of the checkpoint.
 */
export function checkpointFrom(answer: string): string | undefined {
	const open = answer.indexOf(CHECKPOINT_OPEN);
	if (open === -1) return trimmed(answer);
	const close = answer.indexOf(CHECKPOINT_CLOSE, open + CHECKPOINT_OPEN.length);
	return trimmed(answer.slice(open + CHECKPOINT_OPEN.length, close === -1 ? undefined : close));
}

/** A body with nothing but whitespace is not a checkpoint. */
function trimmed(body: string): string | undefined {
	const value = body.trim();
	return value.length > 0 ? value : undefined;
}

/**
 * The first user message of the replacement session.
 *
 * The checkpoint is wrapped so the reader can tell the compacted context from
 * the instruction that follows it: without the boundary the model's prompt
 * reads as more checkpoint prose, and a reader that mistakes the two has no way
 * to tell what it is being asked to do.
 */
export function composeSeed(checkpoint: string | undefined, prompt: string): string {
	const body = checkpoint?.trim();
	return body === undefined || body.length === 0
		? prompt
		: `${CHECKPOINT_OPEN}\n${body}\n${CHECKPOINT_CLOSE}\n\n${prompt}`;
}

/**
 * Split `provider/model` at the first slash only.
 *
 * A model id may itself contain slashes — `routerai/deepseek/deepseek-v4.1-flash`
 * is one model id on one provider — so only the first slash separates the halves.
 */
export function parseProviderModel(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/**
 * The compaction settings, project scope winning over the agent directory.
 *
 * A malformed or unreadable value is treated as absent rather than thrown,
 * because every caller has a working default — the session model. Field-by-field
 * precedence keeps a project override narrow.
 */
export function readCompactSettings(project: unknown, global: unknown): CompactSettings {
	const fromProject = normalizeScope(project).model;
	const fromGlobal = normalizeScope(global).model;
	const model = fromProject ?? fromGlobal;
	// Omitted rather than set to undefined, so a caller can test for the key.
	return model === undefined ? {} : { model };
}

/** One scope's value of this key, ignoring anything unusable. */
function normalizeScope(raw: unknown): CompactSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const value = (raw as Record<string, unknown>)[SETTINGS_KEY];
	if (value === undefined) return {};
	return normalizeScopeValue(value);
}

/** The `model` field of one scope's value of this key. */
function normalizeScopeValue(raw: unknown): CompactSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const model = (raw as Record<string, unknown>).model;
	if (typeof model !== "string") return {};
	const trimmed = model.trim();
	return trimmed.length === 0 ? {} : { model: trimmed };
}
