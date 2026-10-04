/**
 * reprompt — the restart policy.
 *
 * A *seed* is the prompt that opens a replacement session: the first user
 * message of the new context. The model stages one with the `reprompt` tool;
 * settlement delivers it.
 *
 * This module imports no pi runtime, so the policy is testable without starting
 * a session.
 */

/**
 * The part of a transcript entry this policy reads. pi's `SessionEntry` is
 * assignable to it.
 */
export interface TranscriptEntry {
	type: string;
	message?: { role: string; stopReason?: string };
}

/**
 * The stop reasons that mean the model finished its turn: pi's own success
 * partition. `aborted` and `error` are failures, and `pending` means the
 * message was never finalized — a run that crashed mid-stream did not finish.
 */
const COMPLETED: ReadonlySet<string> = new Set(["stop", "length", "toolUse", "deferred"]);

/**
 * Whether the run that staged a seed finished on its own terms.
 *
 * An aborted, failed, or unfinished run is not the model deciding the task is
 * over, so its seed must not replace the session. Entries after the last
 * assistant message — tool results, custom messages — are not the run's
 * outcome and are skipped.
 */
export function runCompleted(entries: readonly TranscriptEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		return COMPLETED.has(entry.message.stopReason ?? "pending");
	}
	return false;
}

/**
 * The prompt a `/reprompt` invocation restarts with.
 *
 * A typed argument is the user asking for that text, so it outranks a claim.
 * Taking the claim first — `selectPrompt(args, seed.take())` — means a typed
 * argument discards it rather than leaving it to be spent by a later invocation.
 */
export function selectPrompt(args: string, claimed: string | undefined): string | undefined {
	return args.trim().length > 0 ? args : claimed;
}

/**
 * The name to dispatch a command by.
 *
 * pi renames every registration of a shared command name to `base:1`, `base:2`
 * and matches a name exactly, so a dispatch to `base` goes unanswered whenever
 * the name is taken — a second copy of this extension is enough. Exactly one
 * candidate is the only case with a known target: more than one means the
 * prompt cannot be delivered, and inventing a name would send the text to the
 * model as an ordinary message instead.
 */
export function dispatchName(registered: readonly string[], base: string): string | undefined {
	const candidates = registered.filter((name) => name === base || name.startsWith(`${base}:`));
	return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The seed staged by the most recent reprompt, and the claim a restart is
 * delivered through.
 *
 * Staging and delivery are separated by pi itself: a session is replaced only
 * from a command context, so the prompt is handed over as a claim rather than
 * as the command's argument, which is reserved for text the user typed. One
 * seed at a time, and each transition below is the whole of its lifecycle.
 */
export class Seed {
	#staged: string | undefined;
	#claimed: string | undefined;

	/**
	 * Stage `prompt`, replacing any seed already waiting.
	 *
	 * Returns false for a blank prompt, leaving the waiting seed untouched, so a
	 * bad call cannot silently empty the replacement session.
	 */
	stage(prompt: string): boolean {
		if (prompt.trim().length === 0) return false;
		this.#staged = prompt;
		return true;
	}

	/**
	 * Move the staged seed into the claim and return it, or return undefined when
	 * nothing was staged.
	 *
	 * Any claim left by an earlier run is discarded either way: a settled run
	 * spends what came before it.
	 */
	claim(): string | undefined {
		const prompt = this.#staged;
		this.#staged = undefined;
		this.#claimed = prompt;
		return prompt;
	}

	/** Take the claim, leaving none behind. A second call yields undefined. */
	take(): string | undefined {
		const prompt = this.#claimed;
		this.#claimed = undefined;
		return prompt;
	}

	/** Drop the staged seed and the claim: the request they carried is void. */
	forget(): void {
		this.#staged = undefined;
		this.#claimed = undefined;
	}
}
