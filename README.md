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
| \`EasyStringNegEditor\` | Easy String Neg Editor | Text Processing | SelectorNeg-style positive/negative builder: visual row editor, old-data import, presets, categories, checkbox manual pick, image hover preview |

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

## EasyStringNegEditor

*SelectorNeg-style* positive/negative builder backed by a **visual row editor**. The node works on both the classic (legacy) ComfyUI frontend and the new Vue-based frontend.

Each row has: an optional **original number** (#), an optional **category**, a tick **checkbox**, a **positive** prompt, a **negative** prompt and an optional **image**. New rows and imported rows **start unticked** - tick the ones you want to use when `select_checked` is on. Images are stored in the workflow JSON itself (downscaled, as a data URL), so the workflow stays self-contained and needs no upload; the image is only a UI aid — it is shown in a preview when you hover the row, and is never sent to the API prompt.

The **category** is a free-text label shown as a small chip on each row; the dialog can filter the list by category. The **checkbox** on each row is a manual pick: when the node input `select_checked` is on, only ticked rows reach the output (this overrides `select_all` and presets).

**Inputs**

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `rows` | STRING (JSON) | 2 demo rows | `[{num?, cat?, on?, pos, neg, img}, …]`; edit it through the **Add / Edit rows** button, not by hand |
| `presets` | STRING (text) | empty | one preset per line: `N: row numbers` (`1: 108 193 135`); edit/import it in the **Presets** tab |
| `line_numbers` | STRING | `1` | rows to use when `select_all`/`use_preset`/`select_checked` are off (`1,3` or `2-4`) |
| `select_all` | BOOLEAN | `true` | `true` = use every row, `false` = use `line_numbers` |
| `select_checked` | BOOLEAN | `false` | `true` = use only rows ticked with the checkbox in the editor (manual pick; overrides `line_numbers` and presets) |
| `use_preset` | BOOLEAN | `false` | `true` = use the preset chosen in `preset_line` instead of rows selection |
| `preset_line` | INT | `1` | which preset (by its number) to apply when `use_preset` is on |
| `weight` | FLOAT (slider) | `1.0` | element weight |
| `apply_weight` | BOOLEAN | `true` | rewrite each element as `(text:weight)` |
| `add_break` | BOOLEAN | `false` | append ` BREAK` to the positive output |
| `preset_trigger` | BOOLEAN (input) | `true` | enable gate; when `false` the node raises an error |
| `data_file` | STRING | empty | dataset file name in the node **data folder** (e.g. `artists.json`); when set, rows + presets are loaded from that file at run time and the workflow stores only this name |

**Outputs:** \`positive_prompt\` (STRING), \`negative_prompt\` (STRING)

Rows behave exactly like \`positive --- negative\` lines in *EasyStringSelectorNeg*: row text is split into comma-separated elements (respecting \`()\`/\`[]\`/\`{}\`), each element is optionally re-weighted, positives are joined to the positive output and negatives to the negative output. A preset number selects the rows whose numbers are listed in it — each number matches a row's **original #** first, then falls back to the 1-based position in the list.

**Importing old data**

The **↧ Import old data** button (Rows tab) pastes a numbered dataset — exactly the format of the old *Easy String Selector Neg* text, one line per row ending with \`~\` — and turns every line into a row: the number is stored as the row's **original #** and the rest of the line goes into the chosen field (**Negative** by default). A line that follows the old SelectorNeg shape `positive --- negative` is split on the first top-level `---`: the part before it becomes the row's **positive** field, the part after it the **negative** field (either side may be empty) - so old datasets with a negative tail are restored correctly. Lines without `---` go entirely into the chosen field. Paste from the clipboard or choose a \`.txt\` file. Original numbers are kept so presets and \`line_numbers\` keep addressing the same rows even after reordering or editing.

**Presets**

The **Presets** tab edits the \`presets\` field directly (\`presetNumber: row numbers\`, e.g. \`7: 108 193 135\`; spaces, commas and ranges like \`1,3 5-7\` all work). Use **↧ Import presets…** to paste a whole block. Set \`use_preset = true\` and choose \`preset_line\` on the node to drive the output from a preset instead of the row selection.

**Using the editor**

- Click the **✎ Rows / Presets — edit** button on the node to open the dialog.
- **Rows** tab: search box, **category filter**, **+ Add row**, **↧ Import old data** and the bulk **✓ all / ✗ none** buttons (tick or untick every row in one click); click any card to edit its tick, category, fields, original number (#), image, order (↑/↓) or delete (🗑). With many rows the dialog renders only the visible part of the list and fills more as you scroll, so it opens instantly even for huge datasets.
- Ticking a row on the node canvas itself (the checkbox at the row start) also toggles its state. Long row sets scroll right on the node with the mouse wheel or the drawn **▲ / ▼** arrows under the list.
- **Presets** tab: type or import \`N: row numbers\` lines directly.
- **Data file** tab: save the whole dataset (rows + presets) to a `.json` file in the node **data folder** (`ComfyUI-EasyStringNodes/data`): type a name (e.g. `artists.json`) and press **Save to file**, or click an existing file to load it. Once a file name is set, the workflow stores only that name - the rows live on disk and can be shared across workflows. The main **Save** button also rewrites the file when a name is set.
- **Save** writes rows and presets (including presets typed in the Presets tab) back into the hidden \`rows\`/\`presets\` widgets in embedded mode, or into the dataset file in dataset mode; **Cancel** (or Esc) discards the changes.
- Hovering a drawn row shows a floating preview with that row's image (when it has one).

> The hidden textareas that store \`rows\` and \`presets\` keep their standard widget names, so workflows, copy/paste and the API prompt work unchanged. The custom list widget never enters the API prompt. In dataset mode (`data_file` set) the rows/presets widgets stay empty on purpose - the workflow only carries the file name and the node reads the file at run time; a missing or invalid file raises a clear error naming it.

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
- \`easy_string_neg_editor.json\` — *EasyStringNegEditor*, two demo rows + demo presets

Load them with the ComfyUI **API-format** workflow loader, or POST the JSON to the \`/prompt\` endpoint.

## License

MIT — see [LICENSE](LICENSE).

## Author

[Ghost-in-the-dark](https://github.com/Ghost-in-the-dark)
