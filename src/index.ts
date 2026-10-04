/**
 * reprompt — the model restarts its own session.
 *
 * A model that has finished a plan, or a step of one, often works better from a
 * clean prompt than from the transcript that produced it. The `reprompt` tool
 * stages the prompt that should open the next context; the run ends; the
 * extension replaces the session and delivers that prompt as its first user
 * message — the effect of `/new` followed by the user typing it.
 *
 * ## Why the first message is compacted
 *
 * A prompt the model writes for itself is a prompt it can also write guardrails
 * out of. So the context being left is compacted into a checkpoint by a second
 * model, in a fixed shape that carries guardrails as a section of its own, and
 * the model's prompt is appended below it. The model still decides what to do
 * next; it no longer decides what it is allowed to do.
 *
 * The prompt is appended after compaction, never given to the compactor: a
 * compactor shown it would fold it into the checkpoint and reword it. The
 * checkpoint policy is in `./compact.ts`.
 *
 * ## Why the tool stages instead of restarting
 *
 * Session replacement belongs to pi's command context, not to a tool or a
 * lifecycle handler: pi exposes `newSession()` only there, because calling it
 * from inside a run deadlocks the runtime. So the tool records the prompt and
 * settlement hands it over, through an extension command pi can dispatch with a
 * real command context.
 *
 * Settlement is `agent_settled` — the one event that follows a run and cannot be
 * continued. Dispatching from it is safe: pi defers a prompt raised while that
 * event is being emitted until settlement has finished.
 *
 * ## Why the prompt travels beside the command
 *
 * Dispatch is by text, and the command's argument doubles as what the user
 * typed, so the staged prompt is claimed at settlement and read from there by
 * the handler. The rule that decides between the two lives in `selectPrompt`.
 *
 * The restart policy itself is in `./seed.ts`, free of any pi import so it can
 * be tested without starting a session.
 */

import {
	convertToLlm,
	type ExtensionContext,
	type ExtensionAPI,
	serializeConversation,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildCompactionPrompt,
	checkpointFrom,
	composeSeed,
	parseProviderModel,
	readCompactSettings,
	type CompactSettings,
} from "./compact.ts";
import { dispatchName, runCompleted, Seed, selectPrompt, type TranscriptEntry } from "./seed.ts";

const RESTART_COMMAND = "reprompt";

/** The compactor's model, or `{}` when nothing usable is configured. */
function readModelSetting(cwd: string): CompactSettings {
	try {
		const settings = SettingsManager.create(cwd);
		// pi's `Settings` has no key for this, but unknown top-level keys survive a
		// load, so the whole scoped object is handed over rather than a named field.
		return readCompactSettings(
			settings.getProjectSettings() as Record<string, unknown>,
			settings.getGlobalSettings() as Record<string, unknown>,
		);
	} catch {
		// An unreadable settings file means "nothing configured", not a failed restart.
		return {};
	}
}

/** One user message for the compactor, in the shape `complete()` expects. */
function compactorMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

/**
 * Compact the ending context into the checkpoint that opens the next one.
 *
 * Returns undefined on every failure rather than throwing: the restart was
 * asked for and the model's prompt is already written, so losing it because a
 * summary call went wrong would be the worse outcome. A checkpoint is a
 * guardrail against the model dropping its own constraints, not a precondition
 * for restarting, so the caller restarts either way and the reason is reported.
 */
async function compactContext(ctx: ExtensionContext): Promise<string | undefined> {
	const configured = readModelSetting(ctx.cwd).model;
	let model = ctx.model;

	if (configured !== undefined) {
		const parsed = parseProviderModel(configured);
		if (parsed === undefined) {
			ctx.ui.notify(`Compaction model "${configured}" is not in provider/model form; using the session model.`, "warning");
		} else {
			const found = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (found === undefined) {
				ctx.ui.notify(`Compaction model "${configured}" names no known model; using the session model.`, "warning");
			} else if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
				ctx.ui.notify(`No credentials for compaction model "${configured}"; using the session model.`, "warning");
			} else {
				model = found;
			}
		}
	}

	if (model === undefined || model === null) {
		ctx.ui.notify("No model to compact with; restarting on your prompt alone.", "warning");
		return undefined;
	}

	// The session projection is what the model actually sees: it already honours
	// compaction entries and context edits, so compacting it cannot resurrect
	// history a previous compaction removed.
	const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
	if (messages.length === 0) return undefined;

	let answer: string;
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages: [compactorMessage(buildCompactionPrompt(serializeConversation(messages)))] },
			// The prompt is sent once and never repeated, so a cached prefix would be
			// paid for and never read.
			{ cacheRetention: "none", signal: ctx.signal },
		);
		if (response.stopReason === "error") {
			ctx.ui.notify(
				`Compaction failed (${response.errorMessage ?? "the model returned an error"}); restarting on your prompt alone.`,
				"warning",
			);
			return undefined;
		}
		answer = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Compaction failed (${reason}); restarting on your prompt alone.`, "warning");
		return undefined;
	}

	const checkpoint = checkpointFrom(answer);
	if (checkpoint === undefined) {
		ctx.ui.notify("The compactor returned nothing usable; restarting on your prompt alone.", "warning");
	}
	return checkpoint;
}

export default function (pi: ExtensionAPI) {
	const seed = new Seed();

	/**
	 * The name this registration is dispatched by. pi renames every copy of a
	 * shared command name (`reprompt:1`, …), so the name is read back rather than
	 * assumed. Undefined means the name is taken by another registration.
	 */
	function resolveDispatchName(): string | undefined {
		return dispatchName(
			pi.getCommands().map((command) => command.name),
			RESTART_COMMAND,
		);
	}

	pi.registerTool({
		name: RESTART_COMMAND,
		label: "Reprompt",
		description:
			"Restart this session in a fresh context. The context being left is compacted into a checkpoint — task, guardrails, current state, what is done, next task — and `prompt` is appended below it as the instruction to act on; the rest is discarded.",
		promptSnippet: "Restart the session in a fresh context with a prompt you write",
		promptGuidelines: [
			"Call `reprompt` when a plan or a plan step is finished and the work that follows should begin in a clean context.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"The instruction that opens the new context, appended below the checkpoint of the context being left. Write it as a directive for a reader who has never seen this conversation: what to do next, and what would count as done. Guardrails, history, and discoveries are carried by the checkpoint, so restate one only if you need it stated differently.",
			}),
		}),

		async execute(_toolCallId, params) {
			if (!seed.stage(params.prompt)) {
				return {
					content: [
						{ type: "text", text: "The prompt was empty, so the session was not restarted. Pass a non-empty `prompt`." },
					],
					details: undefined,
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: "Restarting. The context is compacted into a checkpoint and `prompt` is appended below it; this context ends here.",
					},
				],
				details: undefined,
				terminate: true,
			};
		},
	});

	pi.registerCommand(RESTART_COMMAND, {
		description: "Restart the session, continuing in a fresh context",
		handler: async (args, ctx) => {
			// Taking the claim first makes a typed argument discard it, so a prompt
			// the model staged can never be spent by a later hand-typed invocation.
			const prompt = selectPrompt(args, seed.take());
			if (prompt === undefined || prompt.trim().length === 0) {
				ctx.ui.notify(`Nothing to restart with. Pass a prompt: /${RESTART_COMMAND} <prompt>`, "warning");
				return;
			}
			const parentSession = ctx.sessionManager.getSessionFile();
			// Compact before replacing anything: the context being left is the only
			// place the checkpoint can come from, and `newSession` tears it down.
			const checkpoint = await compactContext(ctx);
			const message = composeSeed(checkpoint, prompt);
			try {
				const { cancelled } = await ctx.newSession({
					parentSession,
					withSession: async (replacement) => {
						await replacement.sendUserMessage(message);
					},
				});
				if (cancelled) {
					ctx.ui.notify("Restart cancelled. This session is unchanged.", "warning");
				}
			} catch (error) {
				// pi replaces the session before the prompt is sent, so a failure here
				// can leave the prompt nowhere to go. Say so rather than reporting
				// success: the caller sees the throw as an extension error otherwise.
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Restarted, but the prompt could not be sent: ${reason}`, "error");
				throw error;
			}
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Claiming both arms this run's seed and discards any claim left by an
		// earlier one, so a stranded claim cannot be spent twice.
		const prompt = seed.claim();
		if (prompt === undefined) return;
		// A run that was aborted, failed, or never finished did not reach the end of
		// its work, so its prompt is stale: drop it rather than restart on it.
		if (!runCompleted(ctx.sessionManager.getBranch() as readonly TranscriptEntry[])) {
			seed.forget();
			return;
		}
		const name = resolveDispatchName();
		if (name === undefined) {
			seed.forget();
			ctx.ui.notify(
				`Another registration already uses /${RESTART_COMMAND}, so the restart could not be started.`,
				"error",
			);
			return;
		}
		pi.sendUserMessage(`/${name}`, { expandPromptTemplates: true });
	});
}
