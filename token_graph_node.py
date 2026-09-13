"""EasyStringTokenGraph: prompt token frequency + co-occurrence, as a graph.

The node takes a prompt string, cuts it into tokens (see esn_tokens), folds
the run into a statistics document and returns the text unchanged plus a
small JSON report. The front-end draws the ranking and the relations as a
floating graph panel.

Why the statistics are recorded in IS_CHANGED
---------------------------------------------
Two different problems meet here.

1. Counting should happen for every run, including a re-queue of a workflow
   the cache already knows: the point of the feature is to measure what the
   user actually uses over time.

2. Writing counters into a widget after a run changes the node's widget
   values, i.e. its execution-cache signature, so the NEXT Queue re-executes
   this node and every downstream node (a fixed seed would resample). That
   exact bug was fixed once already in this pack for the frequency feedback,
   by committing counters "silently" (see esn_core.commitRows).

IS_CHANGED runs on every Queue right before the cache decision, so recording
there is both complete and free: the statistics never touch a widget or an
input, so the signature stays stable and a cached node is still counted.

IS_CHANGED is the ONLY place that writes. `analyse()` consumes the snapshot
that IS_CHANGED left behind for the same signature, and falls back to
recording once when the node is called directly (tests, or an engine that
skips IS_CHANGED) - so no run can be counted twice.

Two counters, two questions
---------------------------
`n` (occurrences) and `runs` (how many runs used the token) answer different
things; a token repeated five times inside one prompt is not "popular" the
way a token used once in five prompts is. Both are reported, and the panel
ranks by occurrences with runs as the tie-break.
"""

import json

try:  # package context (ComfyUI loads the folder as a package)
    from .esn_tokens import (
        DEFAULT_EXCLUDE_TEXT, build_payload, build_report, empty_stats,
        load_stats, merge_run, normalize_stats, parse_exclude, save_stats,
        set_exclude, stats_filename,
    )
except ImportError:  # plain script / test context
    from esn_tokens import (
        DEFAULT_EXCLUDE_TEXT, build_payload, build_report, empty_stats,
        load_stats, merge_run, normalize_stats, parse_exclude, save_stats,
        set_exclude, stats_filename,
    )


def default_prompt():
    """A small demo prompt so the node shows a graph right after it is added."""
    return ("rich details, intense, highly detailed, sharp focus, best quality, "
            "masterpiece, detailed eyes, cinematic, dramatic lighting, "
            "shallow depth of field, digital painting \\(artwork\\), "
            "photorealistic, vignette")


class EasyStringTokenGraph:
    """Rank the tokens of a prompt and record how they relate."""

    # The snapshot IS_CHANGED leaves for analyse() to consume, so one Queue
    # counts exactly once. Class-level on purpose: IS_CHANGED is a classmethod
    # and ComfyUI keeps one instance per node.
    _PENDING = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": default_prompt(),
                        "dynamicPrompts": False,
                        "tooltip": "The prompt to analyse. Cut into sections "
                                   "on BREAK / newlines; quality boilerplate "
                                   "is hidden by default (see 'exclude').",
                    },
                ),
                "stats_file": (
                    "STRING",
                    {
                        "default": "tokens",
                        "tooltip": "Statistics file in the node data folder "
                                   "(<name>.stats.json). Counters accumulate "
                                   "across runs and survive a ComfyUI restart. "
                                   "Leave empty to count in memory only "
                                   "(nothing is written to disk, and the "
                                   "counters reset when ComfyUI restarts).",
                    },
                ),
                "reset": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "reset counters",
                        "label_off": "keep counters",
                        "tooltip": "On: clear the statistics before this run "
                                   "('keep counters' is the normal state).",
                    },
                ),
                "window": (
                    "INT",
                    {
                        "default": 3,
                        "min": 1,
                        "max": 20,
                        "step": 1,
                        "tooltip": "How many neighbouring tokens count as "
                                   "related. Two tokens closer together in the "
                                   "prompt score a stronger edge than two far "
                                   "apart; 1 means immediate neighbours only.",
                    },
                ),
                "top_n": (
                    "INT",
                    {
                        "default": 40,
                        "min": 1,
                        "max": 500,
                        "step": 1,
                        "tooltip": "How many tokens the panel keeps in the "
                                   "ranking (co-occurrence is computed among "
                                   "them).",
                    },
                ),
                "min_count": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "tooltip": "Hide tokens used fewer than this many "
                                   "times: 2 keeps only tokens you reuse.",
                    },
                ),
                "exclude": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": DEFAULT_EXCLUDE_TEXT,
                        "dynamicPrompts": False,
                        "tooltip": "Tokens to keep OUT of the ranking, one per "
                                   "line (or comma separated). Quality "
                                   "boilerplate lives here because it is in "
                                   "every prompt and therefore tells you "
                                   "nothing. * and ? are wildcards, e.g. "
                                   "'year *'. Editable in the panel as well.",
                    },
                ),
                "position": (
                    ["floating", "top", "bottom", "left", "right"],
                    {
                        "default": "floating",
                        "tooltip": "Where the panel opens: a movable floating "
                                   "window, or docked to that edge of the "
                                   "browser window.",
                    },
                ),
            },
            "optional": {
                "text_in": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "Optional prompt from another node. When "
                                   "connected it replaces the 'text' box, so "
                                   "this node can sit inline after any string "
                                   "node.",
                    },
                ),
                "trigger": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "forceInput": True,
                        "label_on": "trigger",
                        "label_off": "blocked",
                        "tooltip": "Optional run gate: leave unconnected to "
                                   "always run, or connect false to block.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "report")
    FUNCTION = "analyse"
    CATEGORY = "Text Processing"
    DESCRIPTION = ("Counts which tokens a prompt uses and how they relate, "
                   "and draws them as a floating graph.")

    # -----------------------------------------------------------------------
    # recording
    # -----------------------------------------------------------------------

    @staticmethod
    def _signature(prompt, stats_file, reset, window, exclude):
        return (str(prompt or ""), str(stats_file or ""),
                bool(reset), int(window or 3), str(exclude or ""))

    @classmethod
    def _record(cls, prompt, stats_file, reset, window, exclude):
        """Fold one run into the statistics and build the panel payload.

        Never raises: a read-only data folder or a malformed statistics file
        must not be able to break a run.
        """
        name = stats_filename(stats_file) if str(stats_file or "").strip() else None
        try:
            if name is None:
                # in-memory mode: keep the document on the class so the panel
                # still has something to draw between runs in this session
                stats = empty_stats() if reset else normalize_stats(cls._MEM)
                stats = merge_run(stats, prompt or "", window=window)
                stats = set_exclude(stats, exclude)
                cls._MEM = stats
            else:
                stats = empty_stats() if reset else load_stats(name)
                stats = merge_run(stats, prompt or "", window=window)
                stats = set_exclude(stats, exclude)
                save_stats(name, stats)
        except Exception:
            stats = normalize_stats(cls._MEM)
        payload = build_payload(stats, exclude=parse_exclude(exclude),
                                limit=40, min_n=1, window=window)
        payload["text"] = prompt or ""
        payload["stats_file"] = name or ""
        return stats, payload

    _MEM = None  # in-memory statistics (stats_file empty)

    @classmethod
    def IS_CHANGED(cls, text="", stats_file="tokens", reset=False, window=3,
                   top_n=40, min_count=1, exclude="", position="floating",
                   text_in=None, trigger=True):
        """Record this run, then let the node be cached normally.

        Returning a constant (rather than NaN) matters: NaN would force every
        downstream node to re-run on each Queue.
        """
        prompt = text_in if text_in is not None and str(text_in).strip() else text
        sig = cls._signature(prompt, stats_file, reset, window, exclude)
        _, payload = cls._record(prompt, stats_file, reset, window, exclude)
        cls._PENDING = {"sig": sig, "payload": payload}
        return "esn-token-graph-1"

    # -----------------------------------------------------------------------
    # execution
    # -----------------------------------------------------------------------

    def analyse(self, text="", stats_file="tokens", reset=False, window=3,
                top_n=40, min_count=1, exclude="", position="floating",
                text_in=None, trigger=True):
        prompt = text_in if text_in is not None and str(text_in).strip() else text
        prompt = prompt or ""
        sig = self._signature(prompt, stats_file, reset, window, exclude)

        # IS_CHANGED normally recorded this run already; consume its snapshot
        # instead of counting the same run a second time.
        pending = type(self)._PENDING
        if pending and pending.get("sig") == sig:
            payload = pending["payload"]
            stats = None
        else:
            stats, payload = self._record(prompt, stats_file, reset, window, exclude)
        type(self)._PENDING = None

        patterns = parse_exclude(exclude)
        payload = dict(payload)
        payload["top_n"] = int(top_n or 40)
        payload["min_count"] = int(min_count or 1)
        payload["position"] = position or "floating"
        if stats is None:
            # consumed IS_CHANGED's snapshot: reload the document it produced
            # so the report matches the payload that was just handed over
            name = stats_filename(stats_file) if str(stats_file or "").strip() else None
            stats = load_stats(name) if name else normalize_stats(type(self)._MEM)
        report = build_report(stats, exclude=patterns, limit=top_n, min_n=min_count)
        return {
            "ui": {"esn_token_graph": [payload]},
            "result": (prompt, report),
        }


NODE_CLASS_MAPPINGS = {"EasyStringTokenGraph": EasyStringTokenGraph}
NODE_DISPLAY_NAME_MAPPINGS = {"EasyStringTokenGraph": "Easy String Token Graph"}
