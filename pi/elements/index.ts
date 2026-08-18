/**
 * Ephemeral UI elements — MVP.
 *
 * MVP scope: agent-produced, round-trip, kind = "select".
 * Out of scope for now: display-only widgets, user-initiated elements.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type ElementSpec, isFailure, type Outcome, renderOutcome, renderSpec, type SelectOption } from "./spec.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Optional detail line" })),
});

const Params = Type.Object({
	prompt: Type.String({ description: "What the user is being asked to choose" }),
	options: Type.Array(OptionSchema, { minItems: 1, description: "Choices offered" }),
	required: Type.Optional(
		Type.Boolean({
			description:
				"If true (default), refusing to answer fails the call and the intended step must not proceed. If false, refusal is a normal outcome.",
		}),
	),
	allow_other: Type.Optional(Type.Boolean({ description: "Offer a free-form answer. Default true." })),
});

type Answer = { value: string; wasOther: boolean } | null;

async function showSelect(ctx: any, spec: ElementSpec): Promise<Answer> {
	const items: SelectItem[] = spec.options.map((o: SelectOption) => ({
		value: o.label,
		label: o.label,
		description: o.description,
	}));
	if (spec.allowOther) items.push({ value: "\u0000other", label: "Type something…" });

	return await ctx.ui.custom<Answer>(
		(tui: any, theme: any, _kb: any, done: (a: Answer) => void) => {
			const container = new Container();
			let editing = false;

			const editorTheme: EditorTheme = {
				borderColor: (s: string) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);
			editor.onSubmit = (value: string) => {
				const trimmed = value.trim();
				if (trimmed) done({ value: trimmed, wasOther: true });
			};

			const list = new SelectList(items, Math.min(items.length, 10), editorTheme.selectList!);
			list.onSelect = (item: SelectItem) => {
				if (item.value === "\u0000other") {
					editing = true;
					rebuild();
					return;
				}
				done({ value: item.value, wasOther: false });
			};
			list.onCancel = () => done(null);

			// Text does not wrap long, styled strings. Keep the prompt as a component
			// so it is reflowed whenever the overlay is resized.
			const prompt = {
				render: (width: number) => wrapTextWithAnsi(theme.fg("accent", theme.bold(spec.prompt)), Math.max(1, width - 4)),
				invalidate: () => {},
			};
			let hintValue = "";
			const hint = {
				render: (width: number) => wrapTextWithAnsi(hintValue, Math.max(1, width - 4)),
				invalidate: () => {},
			};

			function rebuild() {
				container.clear?.();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(prompt as any);
				container.addChild(editing ? editor : list);
				hintValue = theme.fg(
					"dim",
					editing
						? "enter submit • esc back"
						: `↑↓ navigate • enter select • esc ${spec.required ? "refuse (fails call)" : "skip"}`,
				);
				container.addChild(hint);
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				tui.requestRender();
			}
			rebuild();

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (editing) {
						if (matchesKey(data, Key.escape)) {
							editing = false;
							editor.setText("");
							rebuild();
							return;
						}
						editor.handleInput(data);
						tui.requestRender();
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "60%", minWidth: 40, anchor: "center" } },
	);
}

export default function elements(pi: ExtensionAPI) {
	pi.registerTool({
		name: "element",
		label: "Element",
		description:
			"Offer the user a structured choice as an ephemeral UI element instead of asking in prose. Both the offer and the answer enter the transcript. Set required=false when you can proceed without an answer.",
		promptSnippet: "element — ask the user to pick from options via an interactive selector",
		parameters: Params,
		executionMode: "sequential",

		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const spec: ElementSpec = {
				kind: "select",
				prompt: params.prompt,
				options: params.options,
				allowOther: params.allow_other ?? true,
				required: params.required ?? true,
			};

			let outcome: Outcome;
			if (ctx.mode !== "tui") {
				outcome = { status: "unavailable", reason: "no interactive UI in this run mode" };
			} else {
				const answer = await showSelect(ctx, spec);
				outcome = answer ? { status: "answered", ...answer } : { status: "refused" };
			}

			return {
				content: [{ type: "text", text: `${renderSpec(spec)}\n\n${renderOutcome(spec, outcome)}` }],
				details: { spec, outcome },
				isError: isFailure(spec, outcome),
			};
		},
	});
}
