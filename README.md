# ComfyUI Easy String Nodes

A set of lightweight, dependency-free text-processing nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI):

- pick lines from a numbered multiline text by their **original** numbers;
- re-weight every comma-separated element with the \`(tag:weight)\` syntax;
- drive the selection from **presets** and gate a node with a **trigger** input;
- split lines into **positive / negative** prompts;
- concatenate prompt strings into one.

All nodes are pure Python (standard library only) — no extra packages are required, and tests run without ComfyUI.

## Nodes

| Node | Display name | Category | Description |
| --- | --- | --- | --- |
| \`EasyString\` | Easy String | Text Processing | Pick lines from a numbered multiline input |
| \`EasyStringV2\` | Easy String V2 | Text Processing | Pick lines and re-weight every element as \`(text:weight)\` |
| \`EasyStringSelector\` | Easy String Selector | Text Processing | V2 + preset-driven line selection + trigger gate |
| \`EasyStringSelectorNeg\` | Easy String Selector Neg | Text Processing | Split selected lines into positive and negative prompts |
| \`ConcatenatePromptsNode\` | Concatenate Prompts | Text Processing | Join the connected prompt inputs into one string |

## Installation

### ComfyUI Manager (recommended)
Open **ComfyUI Manager → Install Custom Nodes**, search for \`Easy String Nodes\`, then restart ComfyUI.

### Manual
\`\`\`bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ghost-in-the-dark/ComfyUI-EasyStringNodes.git
\`\`\`

Restart ComfyUI — all nodes appear under **Text Processing**. \`pyproject.toml\` is included so the repository can later be published to the [ComfyUI Registry](https://docs.comfy.org/registry/).

## Line selection syntax

Every node that selects lines accepts a small spec language in its \`line_numbers\` (and preset) fields:

| Spec | Meaning |
| --- | --- |
| \`1\` | line 1 |
| \`1,3\` | lines 1 and 3 (in this order) |
| \`2-4\` | lines 2, 3 and 4 (inclusive range) |
| \`1,1\` | line 1 twice (duplicates are kept) |

A line written as \`N: content\` is addressed by its **explicit number N** (e.g. \`10: cat\` is selected with \`10\`). Lines without a \`N: \` prefix are addressed **positionally** (1-based). Unknown tokens raise a clear error instead of silently returning an empty prompt, and a selection that matches nothing raises too.

---

## EasyString

Pick specific lines from a numbered multiline text and join them.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| \`input_text\` | STRING (multiline) | numbered lines, e.g. \`1: a cat\` … |
| \`line_numbers\` | STRING | \`1\` |
| \`add_break\` | BOOLEAN | \`false\` |

**Output:** \`output_text\` (STRING) — the selected lines joined with spaces.

*Example:* \`1: a cat\` / \`2: a dog\` / \`3: a bird\`, selection \`1,3\` → output \`a cat a bird\`. HTML inside lines (including \`<br>\`, \`<p>\`, lists) is converted to plain text with line breaks first, so text pasted from a browser stays clean.

## EasyStringV2

Like *EasyString*, but additionally splits every selected line into comma-separated elements (commas **inside** \`()\`, \`[]\` or \`{}\` are respected) and rewrites each element with a weight.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| \`input_text\` | STRING (multiline) | numbered lines |
| \`line_numbers\` | STRING | \`1\` |
| \`weight\` | FLOAT (slider 0.1–10.0) | \`1.0\` |
| \`apply_weight\` | BOOLEAN | \`true\` |
| \`add_break\` | BOOLEAN | \`false\` |

**Output:** \`output_text\` (STRING)

Behavior:

- \`apply_weight = true\` rewrites every element as \`(text:weight)\`. An element that already carries a numeric weight — \`(text:1.5)\`, \`[text:1.5]\`, \`{text:1.5}\` — keeps its text/brackets but gets the new weight.
- \`apply_weight = false\` returns the cleaned elements as-is (no parentheses added).
- Selection order is preserved, so \`2,1\` outputs line 2 before line 1.
- \`add_break = true\` appends \` BREAK\`.

*Example (apply_weight = true, weight = 1.2):* \`1: cat, dog\`, selection \`1\` → output \`(cat:1.2), (dog:1.2)\`.

## EasyStringSelector

*EasyStringV2* plus **presets** and a **trigger gate**.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| \`input_text\` | STRING (multiline) | numbered lines |
| \`line_numbers\` | STRING | \`1\` |
| \`preset_input\` | STRING (multiline) | \`1: …\` preset lines |
| \`use_preset\` | BOOLEAN | \`false\` |
| \`preset_line\` | INT (1–100) | \`1\` |
| \`preset_trigger\` | BOOLEAN (input) | \`true\` |
| \`weight\` | FLOAT (slider) | \`1.0\` |
| \`apply_weight\` | BOOLEAN | \`true\` |
| \`add_break\` | BOOLEAN | \`false\` |

**Output:** \`output_text\` (STRING)

Presets work the same way as the *line selection* syntax: each numbered line of \`preset_input\` holds a selection spec, and \`preset_line\` picks which one is active. Example preset file:

\`\`\`
1: 1
2: 1,3
\`\`\`

With \`use_preset = true\` and \`preset_line = 2\`, the node selects \`input_text\` lines 1 and 3.

\`preset_trigger\` acts as an **enable gate**: when it is \`false\`, the node raises a clear error instead of producing output, which is useful to intentionally pause a branch of a workflow. Wire it from a widget or from another node; \`forceInput\` lets you connect it.

## EasyStringSelectorNeg

Selects lines like the other nodes but splits each selected line on \`---\` into a **positive** and a **negative** part, outputting both prompts separately.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| \`input_text\` | STRING (multiline) | \`1: … --- …\` |
| \`line_numbers\` | STRING | \`1\` |
| \`preset_input\` | STRING (multiline) | preset lines |
| \`use_preset\` | BOOLEAN | \`false\` |
| \`preset_line\` | INT (1–100) | \`1\` |
| \`preset_trigger\` | BOOLEAN (input) | \`true\` |
| \`weight\` | FLOAT (slider) | \`1.0\` |
| \`apply_weight\` | BOOLEAN | \`true\` |
| \`add_break\` | BOOLEAN | \`false\` |

**Outputs:** \`positive_prompt\` (STRING), \`negative_prompt\` (STRING)

Each selected line may contain \`positive --- negative\`. The part before the first \`---\` goes to the positive output, the part after it to the negative output; lines without \`---\` produce a positive element only. Weighting works exactly as in *EasyStringV2* for both outputs.

*Example (apply_weight = true, weight = 1.0):* \`1: cat --- dog\` / \`2: bird\`, selection \`1,2\` → positive \`(cat:1), (bird:1)\`, negative \`(dog:1)\`.

## ConcatenatePromptsNode

Joins the **connected** prompt inputs into one space-separated string. Inputs are optional: only the ones you wire contribute to the output, and they are joined in numerical order (\`prompt_2\` before \`prompt_10\`).

**Inputs (optional):** \`prompt_1\` … \`prompt_20\` (STRING, multiline). Blank/unconnected inputs are skipped.

**Output:** \`concatenated_prompt\` (STRING)

To change how many are available, edit \`MAX_INPUTS\` at the top of \`Concatenate_prompts.py\` and restart ComfyUI.

## Testing

\`\`\`bash
cd ComfyUI-EasyStringNodes
python3 tests/test_nodes.py
\`\`\`

## Workflow examples

API-format examples live in [examples/workflows](examples/workflows):

- \`easy_string_select_lines.json\` — *EasyString*, pick lines 1 and 3
- \`easy_string_v2_weighted.json\` — *EasyStringV2*, weight elements of one line
- \`easy_string_selector_preset.json\` — *EasyStringSelector*, preset-driven selection
- \`selector_neg_positive_negative.json\` — *EasyStringSelectorNeg*, positive/negative split

Load them with the ComfyUI **API-format** workflow loader, or POST the JSON to the \`/prompt\` endpoint.

## License

MIT — see [LICENSE](LICENSE).

## Author

[Ghost-in-the-dark](https://github.com/Ghost-in-the-dark)
