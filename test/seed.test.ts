import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchName, runCompleted, Seed, selectPrompt, type TranscriptEntry } from "../src/seed.ts";

/** A transcript entry that reads as the model finishing a turn. */
function assistant(stopReason: string): TranscriptEntry {
	return { type: "message", message: { role: "assistant", stopReason } };
}

// --- when a run counts as completed -----------------------------------------

test("a run that stopped on its own has completed", () => {
	assert.equal(runCompleted([assistant("stop"), assistant("toolUse"), assistant("stop")]), true);
});

test("a run the user aborted has not completed", () => {
	assert.equal(runCompleted([assistant("stop"), assistant("aborted")]), false);
});

test("a run that failed has not completed", () => {
	assert.equal(runCompleted([assistant("stop"), assistant("error")]), false);
});

test("a run whose last message was never finalized has not completed", () => {
	assert.equal(runCompleted([assistant("stop"), assistant("pending")]), false);
	assert.equal(runCompleted([{ type: "message", message: { role: "assistant" } }]), false);
});

test("a turn truncated at the token limit still completed", () => {
	assert.equal(runCompleted([assistant("length")]), true);
});

test("entries after the last assistant message do not decide the outcome", () => {
	const toolResult: TranscriptEntry = { type: "message", message: { role: "toolResult" } };
	assert.equal(runCompleted([assistant("stop"), toolResult]), true);
	assert.equal(runCompleted([assistant("aborted"), toolResult]), false);
});

test("a transcript with no assistant message has not completed", () => {
	assert.equal(runCompleted([]), false);
	assert.equal(runCompleted([{ type: "message", message: { role: "user" } }]), false);
	assert.equal(runCompleted([{ type: "model_change" }]), false);
});

// --- staging, claiming, taking ----------------------------------------------

test("staging a prompt makes it available to the next run", () => {
	const seed = new Seed();
	assert.equal(seed.stage("do the next thing"), true);
	assert.equal(seed.claim(), "do the next thing");
	assert.equal(seed.take(), "do the next thing");
	assert.equal(seed.take(), undefined);
});

test("claiming with nothing staged yields nothing", () => {
	assert.equal(new Seed().claim(), undefined);
});

test("the latest staged prompt wins", () => {
	const seed = new Seed();
	seed.stage("first");
	seed.stage("second");
	assert.equal(seed.claim(), "second");
});

test("a blank prompt is rejected and leaves the waiting prompt alone", () => {
	const seed = new Seed();
	seed.stage("keep me");
	assert.equal(seed.stage("   \n\t "), false);
	assert.equal(seed.stage(""), false);
	assert.equal(seed.claim(), "keep me");
});

test("a prompt with surrounding whitespace is kept verbatim", () => {
	const seed = new Seed();
	seed.stage("  padded  ");
	assert.equal(seed.claim(), "  padded  ");
});

test("claiming discards a claim left by an earlier run", () => {
	const seed = new Seed();
	seed.stage("from the first run");
	seed.claim();
	seed.stage("from the second run");
	assert.equal(seed.claim(), "from the second run");
	assert.equal(seed.take(), "from the second run");
});

test("forgetting drops the staged seed and the claim", () => {
	const staged = new Seed();
	staged.stage("never delivered");
	staged.forget();
	assert.equal(staged.claim(), undefined);
	assert.equal(staged.take(), undefined);

	const claimed = new Seed();
	claimed.stage("claimed but never delivered");
	claimed.claim();
	claimed.forget();
	assert.equal(claimed.take(), undefined);
});

// --- choosing the prompt ----------------------------------------------------

test("a typed argument is used as typed", () => {
	assert.equal(selectPrompt("start over on the parser", undefined), "start over on the parser");
});

test("a typed argument outranks the claim", () => {
	assert.equal(selectPrompt("mine", "the model's"), "mine");
});

test("a bare invocation uses the claim", () => {
	assert.equal(selectPrompt("", "the model's"), "the model's");
});

test("whitespace does not count as a typed argument", () => {
	assert.equal(selectPrompt("   ", "the model's"), "the model's");
});

test("a bare invocation with no claim has nothing to restart with", () => {
	assert.equal(selectPrompt("", undefined), undefined);
});

// --- choosing the name to dispatch ------------------------------------------

test("an unclaimed name is dispatched as itself", () => {
	assert.equal(dispatchName(["new", "reprompt", "compact"], "reprompt"), "reprompt");
});

test("a renamed registration is dispatched under its own name", () => {
	assert.equal(dispatchName(["reprompt:1"], "reprompt"), "reprompt:1");
});

test("two registrations leave no name to dispatch to", () => {
	assert.equal(dispatchName(["reprompt:1", "reprompt:2"], "reprompt"), undefined);
});

test("an unrelated command is not mistaken for this one", () => {
	assert.equal(dispatchName(["repromptish", "reprompting"], "reprompt"), undefined);
});
