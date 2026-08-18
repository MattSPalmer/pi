/**
 * Element spec + derivation.
 *
 * Data model:
 *   - An *element* is an immutable spec (what was offered).
 *   - An *outcome* is a separate record referencing the element (what happened).
 *   - Prose shown to the model is derived from the spec, never authored twice.
 *
 * Agent-produced elements ride the tool-call/tool-result pair: the tool call
 * arguments are the element record, the tool result is the outcome record, and
 * `toolCallId` is the reference between them.
 */

export interface SelectOption {
	label: string;
	description?: string;
}

export interface SelectSpec {
	kind: "select";
	prompt: string;
	options: SelectOption[];
	allowOther: boolean;
	required: boolean;
}

export type ElementSpec = SelectSpec;

export type Outcome =
	| { status: "answered"; value: string; wasOther: boolean }
	| { status: "refused" }
	| { status: "unavailable"; reason: string };

/** Derived prose for the element itself (question side). */
export function renderSpec(spec: ElementSpec): string {
	const lines = [spec.prompt, ""];
	for (const [i, o] of spec.options.entries()) {
		lines.push(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
	}
	if (spec.allowOther) lines.push(`  ${spec.options.length + 1}. (free-form answer)`);
	return lines.join("\n");
}

/** Derived prose for the outcome (answer side). */
export function renderOutcome(spec: ElementSpec, outcome: Outcome): string {
	switch (outcome.status) {
		case "answered":
			return outcome.wasOther ? `Answered (free-form): ${outcome.value}` : `Answered: ${outcome.value}`;
		case "refused":
			return spec.required
				? `Unanswered. This element was required, so the requested step did not happen. Ask in prose or proceed differently.`
				: `Unanswered (optional). Continue without this input.`;
		case "unavailable":
			return `Not shown: ${outcome.reason}.${spec.required ? " Element was required." : ""}`;
	}
}

/** Required + no answer is the only failure classification. */
export function isFailure(spec: ElementSpec, outcome: Outcome): boolean {
	return spec.required && outcome.status !== "answered";
}
