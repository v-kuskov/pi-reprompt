/**
 * reprompt — the model restarts its own session.
 *
 * A model that has finished a plan, or a step of one, often works better from a
 * clean prompt than from the transcript that produced it. The `reprompt` tool
 * stages the prompt that should open the next context; the run ends; the
 * extension replaces the session and delivers that prompt as its first user
 * message — the effect of `/new` followed by the user typing it.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dispatchName, runCompleted, Seed, selectPrompt, type TranscriptEntry } from "./seed.ts";

const RESTART_COMMAND = "reprompt";

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
			"Restart this session in a fresh context. `prompt` becomes the first user message of the new context; everything else here is discarded.",
		promptSnippet: "Restart the session in a fresh context with a prompt you write",
		promptGuidelines: [
			"Call `reprompt` when a plan or a plan step is finished and the work that follows should begin in a clean context.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained, for a reader who has never seen this conversation: the goal, the constraints, what is already done, and the next action to take.",
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
						text: "Restarting. `prompt` becomes the first user message of the fresh context; this context ends here.",
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
			try {
				const { cancelled } = await ctx.newSession({
					parentSession,
					withSession: async (replacement) => {
						await replacement.sendUserMessage(prompt);
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
