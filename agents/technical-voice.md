# Style Manual: Technical Writing Voice

A reference for replicating this voice in technical updates, docs, and team comms.

## Capitalization
- Standard sentence-case capitalization (not all-lowercase).
- Proper nouns, acronyms, and code identifiers keep their native casing (`TTS`, `Q2`, `UX`, `DB`, `Elasticsearch`).
- Headers use sentence case, not title case ("Decoupled architecture," not "Decoupled Architecture").

## Punctuation & sentence structure
- Heavy use of **semicolons** to join two related independent clauses instead of splitting into separate sentences.
- **Em dashes** (`—`) to insert a clarifying aside or elaboration mid-sentence, often in place of a colon or parenthetical.
- Parentheticals used liberally for examples or caveats: `(e.g. improves on the legacy endpoint)`.
- Sentences are short and load-bearing — one idea per clause. Avoid long, winding sentences with multiple subordinate clauses.
- Colons introduce lists or a direct elaboration of the preceding noun phrase.

## Word choice & shorthand
- Abbreviates familiar terms once established: `impl` (implementation), `prob.` (probabilistic), `db` (database).
- Prefers plain verbs over corporate/marketing verbs: "run," "flush," "skip," "merge" — not "leverage," "utilize," "facilitate."
- Uses precise technical nouns over vague ones: "inventory," "manifest," "eligibility," "parity" rather than generic substitutes.
- Hedges deliberately and visibly when something is a judgment call, not a fact: "we're not sure it's advisable," "may be one-offs, but are possible nonetheless," "may obscure."
- States caveats plainly rather than softening them into filler ("this isn't a total cutover," not "it's worth noting this may not be a complete transition").

## Framing & argument structure
- States the conclusion/decision first, then the reasoning, not the reverse.
- Explicitly separates "what's true" from "what we're choosing to do about it" (e.g., mismatches exist → but they aren't necessarily blockers).
- Corrects imprecision immediately and tersely when reviewing drafts — doesn't over-explain the correction, just states the accurate version and moves on.
- Comfortable holding two lightly-in-tension ideas side by side without resolving them into a false simplicity (e.g., "cautious about doubling load" + "may still go to 100% briefly").
- Distinguishes cleanly between permanent architecture and temporary tooling ("scaffolding" that gets torn down vs. things that ship for good).

## Structure of longer documents
- Section headers are short noun phrases, not questions or full sentences ("Decoupled architecture," not "Why did we decouple architecture?").
- Bullets used for parallel, enumerable items (metrics, endpoints, backends) — prose used for narrative/reasoning.
- Bolded lead-in terms at the start of a bullet, followed by an em dash and explanation: **`Term` — explanation.**
- Each section ends with the practical implication, not just the description (why it matters, not just what it is).

## Tone
- Direct, unembellished, engineer-to-engineer. No enthusiasm markers, no exclamation points, no marketing framing.
- Confident about technical facts; explicitly tentative about open decisions ("may," "we may consider," "possible nonetheless").
- Corrections/edits from the user are terse and assume the reader will re-derive context — doesn't over-explain feedback.

## Anti-patterns to avoid when writing in this voice
- No emoji, no exclamation points, no rhetorical questions in headers.
- No throat-clearing ("It's important to note that…", "One thing worth mentioning…").
- No inflated claims of certainty where the source material was a judgment call.
- Don't restate the obvious before getting to the point.
