# ComfyUI Easy String Nodes

A set of lightweight, dependency-free text-processing nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI): line selection from multiline text, prompt weighting with the `(tag:weight)` syntax, positive/negative prompt splitting, and prompt concatenation.

All nodes are pure Python (standard library only) — no extra packages are required.

## Nodes

| Node | Display name | Category | Description |
| --- | --- | --- | --- |
| `EasyString` | easy_string | Text Processing | Pick specific lines from a numbered multiline input |
| `EasyStringV2` | Easy String V2 | Text Processing | Pick lines and re-weight every comma-separated element as `(text:weight)` |
| `EasyStringSelector` | Easy String Selector | Text Processing | V2 + preset-based line selection |
| `EasyStringSelectorNeg` | Easy String Selector Neg | Text Processing | Split each selected line into a positive and a negative prompt |
| `ConcatenatePromptsNode` | Concatenate Prompts | Custom | Join up to 15 prompt inputs into a single string |

## Installation

### ComfyUI Manager (recommended)
Open **ComfyUI Manager → Install Custom Nodes** and search for `Easy String Nodes`, then restart ComfyUI.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ghost-in-the-dark/ComfyUI-EasyStringNodes.git
```

Restart ComfyUI. The nodes appear in the node menu under **Text Processing** (and **Custom** for *Concatenate Prompts*).

No registry publishing is required for local use; `pyproject.toml` is included so the repository can later be published to the [ComfyUI Registry](https://docs.comfy.org/registry/).

---

## EasyString

Select specific lines from a numbered multiline text.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | numbered lines, e.g. `1: cat` … |
| `line_numbers` | STRING | `1` |

**Output:** `output_text` (STRING) — the selected lines joined with spaces.

*Example:* input `1: a cat\n2: a dog\n3: a bird`, `line_numbers` = `1,3` → output `a cat a bird`.

> HTML markup inside the lines is stripped and line numbering is re-applied before selection, so text pasted from a browser stays clean.

## EasyStringV2

Like *EasyString*, but additionally splits every selected line into comma-separated elements and rewrites them using the ComfyUI weight syntax.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | numbered lines |
| `line_numbers` | STRING | `1` |
| `weight` | FLOAT (slider 0.1–10.0) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |

**Output:** `output_text` (STRING)

Behavior:

- If `apply_weight` is **on**, every element becomes `(text:weight)`. Elements that already carry a numeric weight — `(text:1.5)` — keep their text but get the new weight.
- If `apply_weight` is **off**, elements are emitted as-is (only cleaned).
- A leading `N:` line-number prefix is removed from each selected line.

*Example (apply_weight = true, weight = 1.2):* input `1: cat, dog\n2: bird`, `line_numbers` = `1` → output `(cat:1.2), (dog:1.2)`.

## EasyStringSelector

All the features of *EasyStringV2* plus *presets*: a second multiline field where each numbered line holds a set of line numbers, so the active selection can be switched with a single `preset_line` number.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | numbered lines |
| `line_numbers` | STRING | `1` |
| `preset_input` | STRING (multiline) | `1: …` preset lines |
| `use_preset` | BOOLEAN | `false` |
| `preset_line` | INT (1–100) | `1` |
| `weight` | FLOAT (slider) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |
| `preset_trigger` (optional) | BOOLEAN (input) | — |

**Output:** `output_text` (STRING)

*Example:* preset line `2: 1,3` means “use lines 1 and 3 of `input_text`”. With `use_preset = true` and `preset_line = 2`, the node selects `input_text` lines 1 and 3.

## EasyStringSelectorNeg

Selects lines like the other nodes but splits each selected line at the separator `---` into a **positive** and a **negative** part, outputting both prompts separately.

**Inputs**

| Input | Type | Default |
| --- | --- | --- |
| `input_text` | STRING (multiline) | `1: … --- …` |
| `line_numbers` | STRING | `1` |
| `preset_input` | STRING (multiline) | preset lines |
| `use_preset` | BOOLEAN | `false` |
| `preset_line` | INT (1–100) | `1` |
| `weight` | FLOAT (slider) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |
| `add_break` | BOOLEAN | `false` |
| `preset_trigger` (optional) | BOOLEAN (input) | — |

**Outputs:** `positive_prompt` (STRING), `negative_prompt` (STRING)

Behavior:

- Each selected line may contain `pos text --- neg text`; the part before the first `---` goes to the positive output, the part after it to the negative output. Lines without `---` produce a positive element only.
- Weighting works exactly as in *EasyStringV2* for both outputs.
- `add_break = true` appends ` BREAK` to the positive output (ignored when positive is empty).

*Example (apply_weight = true, weight = 1.0):* input `1: cat --- dog\n2: bird --- fish`, `line_numbers` = `1,2` → positive `(cat:1), (bird:1)`, negative `(dog:1), (fish:1)`.

## ConcatenatePromptsNode

Joins any number of prompt strings into one space-separated string.

**Inputs:** `prompt_1` … `prompt_15` (STRING). All inputs are always shown; blank ones simply contribute nothing.

**Output:** `concatenated_prompt` (STRING)

**Changing the input count:** edit `NUM_INPUTS` at the top of `Concatenate_prompts.py` and restart ComfyUI:

```python
class ConcatenatePromptsNode:
    NUM_INPUTS = 15  # change this value
```

## Workflow examples

Ready-to-load API-format examples live in [examples/workflows](examples/workflows):

- `easy_string_select_lines.json` — *EasyString*, pick lines 1 and 3
- `easy_string_v2_weighted.json` — *EasyStringV2*, weight elements of one line
- `selector_neg_positive_negative.json` — *EasyStringSelectorNeg*, split positive/negative with weights

Load them via the ComfyUI **API-format** workflow loader, or POST the JSON to the `/prompt` endpoint.

## License

MIT — see [LICENSE](LICENSE).

## Author

[Your GitHub nickname](https://github.com/Ghost-in-the-dark)