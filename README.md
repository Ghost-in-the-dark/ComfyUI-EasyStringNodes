# ComfyUI Easy String Nodes

A set of lightweight, dependency-free text-processing nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI):

- pick lines from a numbered multiline text by their **original** numbers;
- re-weight every comma-separated element with the `(tag:weight)` syntax;
- drive the selection from **presets** and gate a node with a **trigger** input;
- split lines into **positive / negative** prompts;
- concatenate prompt strings into one.

All nodes are pure Python (standard library only) — no extra packages are required, and tests run without ComfyUI.

## Nodes

| Node | Display name | Category | Description |
| --- | --- | --- | --- |
| `EasyString` | Easy String | Text Processing | Pick lines from a numbered multiline input |
| `EasyStringV2` | Easy String V2 | Text Processing | Pick lines and re-weight every element as `(text:weight)` |
| `EasyStringSelector` | Easy String Selector | Text Processing | V2 + preset-driven line selection + trigger gate |
| `EasyStringSelectorNeg` | Easy String Selector Neg | Text Processing | Split selected lines into positive and negative prompts |
| `ConcatenatePromptsNode` | Concatenate Prompts | Text Processing | Join the connected prompt inputs into one string |
| `EasyStringNegEditor` | Easy String Neg Editor | Text Processing | SelectorNeg-style positive/negative builder: visual row editor, old-data import, presets, categories, checkbox manual pick, image hover preview |
| `EasyStringTokenGraph` | Easy String Token Graph | Text Processing | Count which tokens you use most and how they relate: floating co-occurrence graph, quality-token exclusions |

## Installation

### ComfyUI Manager (recommended)
Open **ComfyUI Manager → Install Custom Nodes**, search for `Easy String Nodes`, then restart ComfyUI.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ghost-in-the-dark/ComfyUI-EasyStringNodes.git
```

Restart ComfyUI — all nodes appear under **Text Processing**. `pyproject.toml` is included so the repository can later be published to the [ComfyUI Registry](https://docs.comfy.org/registry/).

## Line selection syntax

Every node that selects lines accepts a small spec language in its `line_numbers` (and preset) fields:

| Spec | Meaning |
| --- | --- |
| `1` | line 1 |
| `1,3` | lines 1 and 3 (in this order) |
| `2-4` | lines 2, 3 and 4 (inclusive range) |
| `1,1` | line 1 twice (duplicates are kept) |

A line written as `N: content` is addressed by its **explicit number N** (e.g. `10: cat` is selected with `10`). Lines without a `N: ` prefix are addressed **positionally** (1-based). Unknown tokens raise a clear error instead of silently returning an empty prompt, and a selection that matches nothing raises too.

---

## EasyString

Pick specific lines from a numbered multiline text and join them.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | numbered lines, e.g. `1: a cat` … |
| `line_numbers` | STRING | `1` |
| `add_break` | BOOLEAN | `false` |

**Output:** `output_text` (STRING) — the selected lines joined with spaces.

*Example:* `1: a cat` / `2: a dog` / `3: a bird`, selection `1,3` → output `a cat a bird`. HTML inside lines (including `<br>`, `<p>`, lists) is converted to plain text with line breaks first, so text pasted from a browser stays clean.

## EasyStringV2

Like *EasyString*, but additionally splits every selected line into comma-separated elements (commas **inside** `()`, `[]` or `{}` are respected) and rewrites each element with a weight.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | numbered lines |
| `line_numbers` | STRING | `1` |
| `weight` | FLOAT (slider 0.1–10.0) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |
| `add_break` | BOOLEAN | `false` |

**Output:** `output_text` (STRING)

Behavior:

- `apply_weight = true` rewrites every element as `(text:weight)`. An element that already carries a numeric weight — `(text:1.5)`, `[text:1.5]`, `{text:1.5}` — keeps its text/brackets but gets the new weight.
- `apply_weight = false` returns the cleaned elements as-is (no parentheses added).
- Selection order is preserved, so `2,1` outputs line 2 before line 1.
- `add_break = true` appends ` BREAK`.

*Example (apply_weight = true, weight = 1.2):* `1: cat, dog`, selection `1` → output `(cat:1.2), (dog:1.2)`.

## EasyStringSelector

*EasyStringV2* plus **presets** and a **trigger gate**.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | numbered lines |
| `line_numbers` | STRING | `1` |
| `preset_input` | STRING (multiline) | `1: …` preset lines |
| `use_preset` | BOOLEAN | `false` |
| `preset_line` | INT (1–100) | `1` |
| `preset_trigger` | BOOLEAN (input) | `true` |
| `weight` | FLOAT (slider) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |
| `add_break` | BOOLEAN | `false` |

**Output:** `output_text` (STRING)

Presets work the same way as the *line selection* syntax: each numbered line of `preset_input` holds a selection spec, and `preset_line` picks which one is active. Example preset file:

```
1: 1
2: 1,3
```

With `use_preset = true` and `preset_line = 2`, the node selects `input_text` lines 1 and 3.

`preset_trigger` acts as an **enable gate**: when it is `false`, the node raises a clear error instead of producing output, which is useful to intentionally pause a branch of a workflow. Wire it from a widget or from another node; `forceInput` lets you connect it.

## EasyStringSelectorNeg

Selects lines like the other nodes but splits each selected line on `---` into a **positive** and a **negative** part, outputting both prompts separately.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | `1: … --- …` |
| `line_numbers` | STRING | `1` |
| `preset_input` | STRING (multiline) | preset lines |
| `use_preset` | BOOLEAN | `false` |
| `preset_line` | INT (1–100) | `1` |
| `preset_trigger` | BOOLEAN (input) | `true` |
| `weight` | FLOAT (slider) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |
| `add_break` | BOOLEAN | `false` |

**Outputs:** `positive_prompt` (STRING), `negative_prompt` (STRING)

Each selected line may contain `positive --- negative`. The part before the first `---` goes to the positive output, the part after it to the negative output; lines without `---` produce a positive element only. Weighting works exactly as in *EasyStringV2* for both outputs.

*Example (apply_weight = true, weight = 1.0):* `1: cat --- dog` / `2: bird`, selection `1,2` → positive `(cat:1), (bird:1)`, negative `(dog:1)`.

## EasyStringNegEditor

*SelectorNeg-style* positive/negative builder backed by a **visual row editor**. The node works on both the classic (legacy) ComfyUI frontend and the new Vue-based frontend.

Each row has: an optional **original number** (#), an optional **category**, a tick **checkbox**, a **positive** prompt, a **negative** prompt and an optional **image**. New rows and imported rows **start unticked**. With `select_checked` on, only ticked rows are used; with `select_all` off and `line_numbers` left empty the ticked rows are used as well. When nothing is selected (nothing ticked, empty `line_numbers`, or a preset / row numbers that match no row), the node simply outputs empty strings instead of raising, so an empty choice is a valid "no rows" result. Images are a UI aid only — shown in a preview when you hover the row, never sent to the API prompt. With **no dataset file** the picture stays in the workflow JSON as a downscaled data URL, so the workflow remains self-contained. **In dataset-file mode it is uploaded once and stored as a file** next to the dataset (`data/<name>.img/...`); the row keeps only that file name, so the dataset JSON stays tiny and a checkbox click no longer re-sends and rewrites every image in it (a 200-image dataset used to mean ~10 MB written per click). Saving an older dataset that still carries inline base64 images moves them into files automatically — that is what the amber **inline** badge on a row card means — and the Save in the Data tab reports the new size.

The **category** is a free-text label shown as a small chip on each row. Clicking that chip **filters the node list to that category** (the same filter the dialog's category picker sets); clicking the chip of the active category again, or the ✕ on the status bar's category chip, clears it. The dialog's category picker offers every category with its row count and a typed category becomes selectable right away. The **checkbox** on each row is a manual pick: when the node input `select_checked` is on, only ticked rows reach the output (this overrides `select_all` and presets). With `preset_checked` on, the same checkbox also filters **inside a preset**: a preset may then only use its rows that are ticked as well, so a preset can be trimmed by unticking rows instead of editing its number list. Every row a preset points at gets that checkbox on the node (next to the preset line) and in the dialog's **Presets** tab, so both places show and set the same flag.

**Inputs**

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `rows` | STRING (JSON) | 2 demo rows | `[{num?, cat?, on?, pos, neg, img, freq?}, …]`; edit it through the **Add / Edit rows** button, not by hand |
| `presets` | STRING (text) | empty | one preset per line: `N: row numbers` (`1: 108 193 135`); edit/import it in the **Presets** tab |
| `line_numbers` | STRING | `` (empty) | rows to use when `select_all`/`use_preset`/`select_checked` are off (`1,3` or `2-4`); leave empty to use the checkbox-ticked rows; empty result outputs empty strings |
| `select_all` | BOOLEAN | `true` | `true` = use every row, `false` = use `line_numbers` (or the checkbox-ticked rows when `line_numbers` is empty); an empty selection outputs empty strings |
| `select_checked` | BOOLEAN | `false` | `true` = use only rows ticked with the checkbox in the editor (manual pick; overrides `line_numbers` and presets); none ticked outputs empty strings |
| `use_preset` | BOOLEAN | `false` | `true` = use the preset chosen in `preset_line` instead of rows selection |
| `preset_line` | INT | `1` | which preset (by its number) to apply when `use_preset` is on |
| `weight` | FLOAT (slider) | `1.0` | element weight |
| `apply_weight` | BOOLEAN | `true` | rewrite each element as `(text:weight)` |
| `add_break` | BOOLEAN | `false` | append ` BREAK` to the positive output |
| `preset_trigger` | BOOLEAN (optional input) | `true` | optional run gate - **leave unconnected to always run**, or connect `false` to block the node with an error |
| `data_file` | STRING | empty | dataset file name in the node **data folder** (e.g. `artists.json`); when set, rows + presets are loaded from that file at run time and the workflow stores only this name |
| `preset_checked` | BOOLEAN | `false` | `true` = a preset may only use its rows that are also ticked with the checkbox (preset ∩ ticked); `false` = the preset uses all of its rows, whatever the ticks. Has no effect unless `use_preset` is on |

**Outputs:** `positive_prompt` (STRING), `negative_prompt` (STRING)

Rows behave exactly like `positive --- negative` lines in *EasyStringSelectorNeg*: row text is split into comma-separated elements (respecting `()`/`[]`/`{}`), each element is optionally re-weighted, positives are joined to the positive output and negatives to the negative output. A preset number selects the rows whose numbers are listed in it — each number matches a row's **original #** first, then falls back to the 1-based position in the list.

**Importing old data**

The **↧ Import old data** button (Rows tab) pastes a numbered dataset — exactly the format of the old *Easy String Selector Neg* text, one line per row ending with `~` — and turns every line into a row: the number is stored as the row's **original #** and the rest of the line goes into the chosen field (**Negative** by default). A line that follows the old SelectorNeg shape `positive --- negative` is split on the first top-level `---`: the part before it becomes the row's **positive** field, the part after it the **negative** field (either side may be empty) - so old datasets with a negative tail are restored correctly. Lines without `---` go entirely into the chosen field. Paste from the clipboard or choose a `.txt` file. Original numbers are kept so presets and `line_numbers` keep addressing the same rows even after reordering or editing.

**Presets**

The **Presets** tab edits the `presets` field directly (`presetNumber: row numbers`, e.g. `7: 108 193 135`; spaces, commas and ranges like `1,3 5-7` all work). Use **↧ Import presets…** to paste a whole block. Set `use_preset = true` and choose `preset_line` on the node to drive the output from a preset instead of the row selection.

**Using the editor**

- Click the **✎ Rows / Presets — edit** button on the node to open the dialog.
- **Rows** tab: search box, **category filter** (each entry shows its row count; typing a new category into a card's `Cat:` field makes it selectable without reopening the dialog), **+ Add row**, **↧ Import old data** and the bulk **Tick all / Untick all** buttons — these act on the rows the dialog currently shows, and their label carries that count (`Tick all 12`). Click any card to edit its tick, category, fields, original number (#), image, order or delete. With many rows the dialog renders only the visible part of the list and fills more as you scroll, so it opens instantly even for huge datasets.
- Ticking a row on the node canvas itself (the checkbox at the row start) also toggles its state. Long row sets scroll right on the node with the mouse wheel, the drawn **▲ / ▼** arrows under the list, or the **drag scrollbar** on the right edge of the rows area (when the preset list overflows, the wheel scrolls it too).
- **On-node search**: the small search field under the header filters rows by number, category or text (`pos`/`neg`) live — the header then shows *Rows (matched/total)*, unmatched rows are hidden, and the ✕ in the field clears the filter. It searches the same way as the dialog search box. Search, *only* and the category filter are three independent filters that combine with AND, and the bulk tick buttons always act on the result of that combination.
- **On-node buttons**: directly under the search bar sit five buttons — **all** (tick), **none** (untick), **only** (view filter: show only the ticked rows), **cat** (open the category picker) and **use** (order the display by usage frequency). The tick buttons act on the rows the current filters show (search + *only* + category, combined with AND) and carry the number of rows they would touch as a badge in their top-right corner, so the count stays readable on a narrow node. There is no colour-only state anywhere: every button pairs its highlight with a label, a drawn icon and a badge.
- **Status bar**: the line under the buttons always states what you are looking at — `ticked 12 / 569` normally, and `showing 3 / 569 · cat artists + "portrait"` while any filter is active, so the header count and the list below can never appear to disagree. Turning on **only** when every row happens to be ticked says so and offers a one-click **✗ none** right there.
- **Category picker**: the **cat** button lists every category with its row count (and *All categories* to clear). The same list is available in the dialog's category selector, and both views share one filter state. The active filter is shown as a chip on the status bar; clicking that chip (or the chip on a row) clears it.
- **Usage ranking**: every row keeps a hidden `freq` counter that the node bumps once each time the row is actually selected by a run (`select_all`, `line_numbers`, preset or ticked checkbox). Used rows show a warm tint plus a **×N** counter on the right. The **⇅ use** button on the node sorts the *display* by frequency (most-used first; click again to restore the stored order) — it never rewrites the stored rows, so a workflow reload cannot leave the list permanently sorted. The dialog's **⇅ by use** button reorders the working copy on purpose (press **Save** to keep it), and **↺ # order** restores the original order by row number to undo an accidental frequency reorder. Counters persist in the workflow/dataset, so the ranking survives reloads.
- A **Presets** panel is drawn right on the node under the rows (like the old *Easy String Selector Neg*): it lists the preset lines, highlights the active one, and shows `preset off — all rows / line_numbers mode` when no preset is picked. Use the mini **use:on/off** toggle and the **◀ / ▶** buttons right there to turn the preset mode on and pick a preset, or click a preset line / the panel header to open the dialog on the **Presets** tab.
- **Presets** tab: type or import `N: row numbers` lines directly.
- **Data file** tab: save the whole dataset (rows + presets) to a `.json` file in the node **data folder** (`ComfyUI-EasyStringNodes/data`): type a name (e.g. `artists.json`) and press **Save to file**, or click an existing file to load it. Once a file name is set, the workflow stores only that name - the rows live on disk and can be shared across workflows. The main **Save** button also rewrites the file when a name is set.
- **Save** writes rows and presets (including presets typed in the Presets tab) back into the hidden `rows`/`presets` widgets in embedded mode, or into the dataset file in dataset mode; **Cancel** (or Esc) discards the changes.
- Hovering a drawn row shows a floating preview with that row's image (when it has one).

> The hidden textareas that store `rows` and `presets` keep their standard widget names, so workflows, copy/paste and the API prompt work unchanged. The custom list widget never enters the API prompt. In dataset mode (`data_file` set) the rows/presets widgets stay empty on purpose - the workflow only carries the file name and the node reads the file at run time; a missing or invalid file raises a clear error naming it.

## ConcatenatePromptsNode

Joins the **connected** prompt inputs into one space-separated string. Inputs are optional: only the ones you wire contribute to the output, and they are joined in numerical order (`prompt_2` before `prompt_10`).

**Inputs (optional):** `prompt_1` … `prompt_20` (STRING, multiline). Blank/unconnected inputs are skipped.

**Output:** `concatenated_prompt` (STRING)

To change how many are available, edit `MAX_INPUTS` at the top of `Concatenate_prompts.py` and restart ComfyUI.

## EasyStringTokenGraph

Shows which tokens you actually use, and which ones you use **together**. The text passes through unchanged, so it can sit anywhere in an existing prompt chain and only observe.

Give it a text and it counts every token, remembers the counts across runs, and draws them as a **floating graph**: the dot size is how often a token is used, and a line means two tokens appear near each other in the same prompt. Hover a token to see what it is used with.

**Inputs:** `text` (STRING, multiline), `stats_file`, `reset`, `window`, `top_n`, `min_count`, `exclude`, `position`
**Optional:** `text_in` (STRING, overrides `text` when connected and non-blank), `trigger` (BOOLEAN)
**Outputs:** `text` (the input, unchanged), `report` (JSON with the ranking and the stats file path)

### The panel

| Control | What it does |
| --- | --- |
| double-click the node, or **show graph** on the node strip | open / close the floating panel |
| drag the panel header | move it; `Esc` closes it |
| `floating` / `top` / `bottom` / `left` / `right` selector | dock the panel to a window edge |
| **live** | fold the text currently in the node's box into the ranking, before you Queue |
| **exclusions** | edit which tokens stay out of the ranking |
| **reload** | re-read the accumulated history from the server |

Hovering a token — in the graph or in the ranking list — dims everything unrelated and opens a readout: how many uses, in how many runs, and **which tokens it is used with**, ranked by how strongly they co-occur. `window` controls how far apart two tokens may be and still count as related; `1` means immediate neighbours only.

### Quality tokens

Boilerplate such as `best quality`, `masterpiece`, `8k` or `highly detailed` is in every prompt, so it always dominates the ranking and tells you nothing. Those tokens are excluded by default: they are still counted (nothing is deleted, and the `report` output includes them), they are simply kept out of the ranking and the graph.

The `exclude` list matches whole tokens, so `detailed` is hidden while `detailed eyes` and `detailed background` — which are content — stay. `*` and `?` are wildcards, so `year *` covers `year 2022` through `year 2024`. Editing the list in the panel applies immediately to the panel and on the next run to the node.

### Keeping history

Counters are stored in `data/token_stats/<stats_file>.stats.json` and accumulate across runs, so the graph becomes more useful the more you use it.

- Leave `stats_file` **empty** to count in memory only: nothing is written to disk, and the counters reset when ComfyUI restarts.
- Set `reset` to `true` for one run to clear that file's counters before it runs.
- Statistics live in their own subfolder and are never listed as datasets.

### Notes

- Two numbers are tracked per token: **uses** (total occurrences) and **runs** (how many prompts contained it). Five uses inside one prompt is one run, and the two answer different questions, so both are shown.
- Tokens are folded for counting: `HDR_Photo`, `hdr-photo` and `HDR Photo` are one token, displayed with the spelling used most recently.
- Counting happens in `IS_CHANGED`, which runs on every Queue but touches no widget, so it never invalidates the node's cache signature or forces downstream nodes to re-run.
- The panel needs its own tokenizer, because it re-ranks the text you are still typing; a parity test keeps it identical to the Python one.

## Testing

```bash
cd ComfyUI-EasyStringNodes
python3 tests/test_nodes.py          # node logic
python3 tests/test_token_graph.py    # token counting, exclusions, one-run-one-count
python3 tests/test_token_parity.py   # python vs javascript tokenizer (needs node)
node tests/canvas_balance.mjs        # canvas state balance (node front-end)
node tests/tg_canvas_balance.mjs     # canvas state balance (token graph)
node tests/tg_layout_test.mjs        # force layout determinism, bounds, hit testing
node tests/tg_exclude_hidden.mjs     # the exclude input collapses without losing its value
node tests/tg_widget_click.mjs       # the on-node "show graph" button responds to a click
```

`tests/canvas_balance.mjs` drives the on-node widget through every drawing state (rows, presets, filters, category popover, collapsed settings) with a recording 2D context and asserts one invariant: **the context state stack depth after `draw()` equals the depth before it**. The widget draws onto ComfyUI's shared canvas, so a `ctx.restore()` that is not paired with a `ctx.save()` pops the state frame the graph renderer saved for itself; every node and link drawn afterwards then inherits this widget's `fillStyle`, `globalAlpha` and lost transform, and renders blank or as a solid black slab. Counting `grep -c ctx.save()` does not catch this (the same words appear in comments), which is why the check is behavioural. Both commands need no third-party packages and no browser.

`tests/tg_canvas_balance.mjs` additionally fails when two labels would be painted on the same baseline or outside the strip: the token strip is drawn into whatever height ComfyUI grants it, and a node resized by hand can grant far less than `computeSize()` asked for. Two captions landing on one line is a rendering bug even when the save/restore balance is perfect.

`tests/tg_widget_click.mjs` drives `draw()` and `mouse()` with the same origin, the way the front-end does, and asserts the "show graph" button actually toggles the panel. Those two entry points use **different coordinate frames** - `draw()` receives the widget's top in node space while `mouse()` receives a position in that same frame - and the strip once hit-tested as if `pos` were already widget-relative. The result was a button that rendered perfectly and did nothing when clicked, which no test caught because nothing called `mouse()`.

`tests/tg_exclude_hidden.mjs` covers the `exclude` input. Its default value is the fifty-line boilerplate list, and ComfyUI sizes a multiline widget to roughly its content, so a visible `exclude` reserved hundreds of pixels of node body. The node collapses it (the same way `EasyStringNegEditor` hides its data widgets) and the test asserts both halves of that: the height really goes to zero, and the value stays readable and writable through the panel's exclusions drawer.

## Workflow examples

API-format examples live in [examples/workflows](examples/workflows):

- `easy_string_select_lines.json` — *EasyString*, pick lines 1 and 3
- `easy_string_v2_weighted.json` — *EasyStringV2*, weight elements of one line
- `easy_string_selector_preset.json` — *EasyStringSelector*, preset-driven selection
- `selector_neg_positive_negative.json` — *EasyStringSelectorNeg*, positive/negative split
- `easy_string_neg_editor.json` — *EasyStringNegEditor*, two demo rows + demo presets

Load them with the ComfyUI **API-format** workflow loader, or POST the JSON to the `/prompt` endpoint.

## License

MIT — see [LICENSE](LICENSE).

## Author

[Ghost-in-the-dark](https://github.com/Ghost-in-the-dark)
