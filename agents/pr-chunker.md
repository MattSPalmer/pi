Analyze the logical changes (functions/classes/methods) in the current PR/commit, tag them with structured orthogonal axes, and aggregate the findings into a report.

## 1. Get the lay of the land
Run `diff-digestor` to get a stat summary and a truncated per-file diff sample:
```bash
diff-digestor
```
If there are no changed files, report this to the user and stop.

## 2. Identify logical chunks
Using the stat summary and samples, identify the logical chunks (functions/classes/methods) touched by this change. For any file where the truncated sample doesn't show enough to identify a chunk's boundaries — large files, or samples that cut off mid-function — fetch that file's full diff yourself before proceeding:
```bash
jj diff --git -- <file>   # or: git diff -- <file>
```

## 3. Evaluate and Tag Chunks
For each chunk you identified, evaluate its role in the codebase and tag it with the following orthogonal axes:

1. **Category**:
   - `config`: Configuration files, properties, or package definitions.
   - `test`: Tests, specifications, or assertion-related code.
   - `fixture`: Test data, mocks, seeds, or factories.
   - `infra`: Infrastructure, Nix files, CI/CD, build tools, or system setup.
   - `logic`: Pure domain logic, functions, algorithms, UI components, business rules, or database schemas.

2. **Leverage (Static)**:
   - `low`: Low utility or leaf nodes. Little to no dependencies import this.
   - `med`: Shared utilities, helpers, or types used by a few modules.
   - `high`: Foundation elements, core framework interfaces, widely used utils, or database schemas imported by many modules.

3. **Scope (Dynamic)**:
   - `isolated`: No external dependency side-effects. Failure is contained.
   - `interaction`: Involves a combination of 2-3 specific modules. Moderate blast radius.
   - `orchestrating`: Highly connected orchestrator or entrypoint. Failure impacts the whole feature or system.

For each chunk, provide:
- The class/function/method name and file path.
- The tag assignment for Category, Leverage, and Scope.
- A 1-2 sentence justification for the classification.

## 4. Aggregate findings and Generate Report
Perform a frequency analysis of the assigned axis tuples. Group similar tuples (e.g., `(logic, low, isolated)`) and count their occurrences.

Render a professional, gorgeous markdown report:
- **Header**: PR Chunker Report with date/time.
- **Executive Summary**: A summary of overall changes and a table or bulleted list of the axis tuple frequency analysis.
- **Key Risks / Red Flags**: Call out any chunk classified with `high` Leverage and `orchestrating` Scope as high-risk or high-blast-radius, recommending extra testing/attention.
- **Detailed Breakdown**: Grouped by file, list each modified chunk, its assigned axes (rendered elegantly, e.g., using bolding or inline code), and the brief justification.

Save the markdown report to a temporary file:
```bash
mktemp -t pr-chunker-report-XXXXXX.md
```
Write the report to that file.
Hand back the absolute file path of the report and print the full generated markdown report directly so the user can see it.
