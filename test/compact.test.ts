import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildCompactionPrompt,
	CHECKPOINT_CLOSE,
	CHECKPOINT_OPEN,
	CHECKPOINT_SECTIONS,
	checkpointFrom,
	composeSeed,
	parseProviderModel,
	readCompactSettings,
} from "../src/compact.ts";

// --- what the compactor is asked for ----------------------------------------

test("the prompt carries the conversation inside its own delimiters", () => {
	const prompt = buildCompactionPrompt("[User]: fix the parser");
	assert.match(prompt, /<conversation>\n\[User\]: fix the parser\n<\/conversation>/);
});

test("the prompt asks for the checkpoint inside the tags the reader looks for", () => {
	const prompt = buildCompactionPrompt("anything");
	// The block it is asked to write is opened and closed, so the two tags the
	// reader cuts between both appear in the request.
	assert.ok(prompt.includes(`${CHECKPOINT_OPEN}\n## Task`));
	assert.ok(prompt.includes(CHECKPOINT_CLOSE));
});

test("every required section is asked for, in order", () => {
	const prompt = buildCompactionPrompt("anything");
	const positions = CHECKPOINT_SECTIONS.map((section) => prompt.indexOf(`## ${section}`));
	assert.ok(positions.every((at) => at !== -1), "a section heading is missing");
	assert.deepEqual(
		[...positions].sort((a, b) => a - b),
		positions,
		"section headings are out of order",
	);
});

test("guardrails and next task are sections of their own, as the failure criteria require", () => {
	assert.ok(CHECKPOINT_SECTIONS.includes("Guardrails"));
	assert.ok(CHECKPOINT_SECTIONS.includes("Next Task"));
});

test("the prompt tells the compactor to preserve guardrails verbatim", () => {
	const prompt = buildCompactionPrompt("anything");
	assert.match(prompt, /wording of every guardrail/);
	assert.match(prompt, /paths, function names, error messages/);
});

// --- reading the checkpoint back --------------------------------------------

test("the block between the tags is the checkpoint", () => {
	const answer = `${CHECKPOINT_OPEN}\n## Task\nship it\n${CHECKPOINT_CLOSE}`;
	assert.equal(checkpointFrom(answer), "## Task\nship it");
});

test("prose around the block is discarded", () => {
	const answer = `Here is the checkpoint:\n\n${CHECKPOINT_OPEN}\nbody\n${CHECKPOINT_CLOSE}\n\nHope that helps.`;
	assert.equal(checkpointFrom(answer), "body");
});

test("an answer without the tags is used whole", () => {
	// Sections written without the tags are still a usable checkpoint; throwing
	// them away would spend the model call and restart with nothing.
	assert.equal(checkpointFrom("## Task\nship it"), "## Task\nship it");
});

test("an answer with no text yields no checkpoint", () => {
	assert.equal(checkpointFrom(""), undefined);
	assert.equal(checkpointFrom("   \n\t "), undefined);
});

test("an unterminated block still yields the body", () => {
	// A token-limited answer can lose the closing tag; the body is still the
	// checkpoint, and dropping it would restart on the prompt alone for no reason.
	const answer = `${CHECKPOINT_OPEN}\n## Task\nhalf a checkpoint`;
	assert.equal(checkpointFrom(answer), "## Task\nhalf a checkpoint");
});

test("the opening tag without a body yields no checkpoint", () => {
	assert.equal(checkpointFrom(`${CHECKPOINT_OPEN}\n${CHECKPOINT_CLOSE}`), undefined);
});

// --- the first message of the new session ------------------------------------

test("the seed carries the checkpoint and then the model's prompt", () => {
	const seed = composeSeed("## Task\nship it", "Start with the parser.");
	assert.equal(seed, `${CHECKPOINT_OPEN}\n## Task\nship it\n${CHECKPOINT_CLOSE}\n\nStart with the parser.`);
});

test("the checkpoint comes before the prompt, so the prompt reads as the instruction", () => {
	const seed = composeSeed("checkpoint body", "do this next");
	assert.ok(seed.indexOf("checkpoint body") < seed.indexOf("do this next"));
});

test("with no checkpoint the seed is the prompt alone", () => {
	// A failed compaction must not strand a restart the model asked for.
	assert.equal(composeSeed(undefined, "do this next"), "do this next");
	assert.equal(composeSeed("", "do this next"), "do this next");
	assert.equal(composeSeed("   ", "do this next"), "do this next");
});

test("the prompt is kept verbatim, leading and trailing whitespace included", () => {
	const seed = composeSeed("body", "  padded  ");
	assert.ok(seed.endsWith("  padded  "));
});

// --- resolving the compactor's model ----------------------------------------

test("a provider and model split at the first slash only", () => {
	assert.deepEqual(parseProviderModel("routerai/deepseek/deepseek-v4.1-flash"), {
		provider: "routerai",
		modelId: "deepseek/deepseek-v4.1-flash",
	});
});

test("a value that is not provider/model form is rejected", () => {
	assert.equal(parseProviderModel("justamodel"), undefined);
	assert.equal(parseProviderModel("/leading"), undefined);
	assert.equal(parseProviderModel("trailing/"), undefined);
	assert.equal(parseProviderModel(""), undefined);
});

test("nothing configured leaves the model unset", () => {
	assert.deepEqual(readCompactSettings(undefined, undefined), {});
	assert.deepEqual(readCompactSettings({}, {}), {});
	assert.deepEqual(readCompactSettings({ reprompt: {} }, { reprompt: {} }), {});
});

test("the configured model is read out of this extension's own key", () => {
	assert.deepEqual(readCompactSettings({ reprompt: { model: "a/b" } }, undefined), { model: "a/b" });
	assert.deepEqual(readCompactSettings(undefined, { reprompt: { model: "a/b" } }), { model: "a/b" });
});

test("the project scope wins over the agent directory", () => {
	assert.deepEqual(
		readCompactSettings({ reprompt: { model: "project/model" } }, { reprompt: { model: "global/model" } }),
		{ model: "project/model" },
	);
});

test("a project without the key leaves the agent directory's model in force", () => {
	// Field-by-field precedence: a project setting something else must not erase
	// the model the user configured globally.
	assert.deepEqual(readCompactSettings({ other: true }, { reprompt: { model: "global/model" } }), {
		model: "global/model",
	});
});

test("an unusable value is treated as unconfigured rather than thrown", () => {
	assert.deepEqual(readCompactSettings({ reprompt: { model: 42 } }, undefined), {});
	assert.deepEqual(readCompactSettings({ reprompt: { model: "   " } }, undefined), {});
	assert.deepEqual(readCompactSettings({ reprompt: "a/b" }, undefined), {});
	assert.deepEqual(readCompactSettings({ reprompt: [] }, undefined), {});
	assert.deepEqual(readCompactSettings("junk", "junk"), {});
});

test("a model is trimmed, so surrounding whitespace is not part of it", () => {
	assert.deepEqual(readCompactSettings({ reprompt: { model: "  a/b  " } }, undefined), { model: "a/b" });
});
