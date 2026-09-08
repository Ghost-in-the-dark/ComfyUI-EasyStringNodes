// EasyStringNegEditor — entry point.
//
// Adds a visual row list + "Rows / Presets / Data file" dialog to the
// EasyStringNegEditor node. Compatible with BOTH the legacy ComfyUI web UI
// and the new ComfyUI_frontend based UI.
//
// v1.5.6: front-end split into small ESM modules for readability (this file
// is now only the entry point that registers the extension).
// v1.5.5: on-node search bar (filters by num/cat/pos/neg), a usage-frequency
// ranking (×N counters fed back from Python through onExecuted, header ⇅ sort
// and dialog ⇅ by use), and a draggable scrollbar for long row lists.
//
// The front-end code is split into small ESM modules:
//
//   esn_core.js        shared data: constants, row/preset parsing, commit*,
//                      dataset-file I/O, image downscaling
//   esn_view.js        node view model: search filtering, freq sort, sizing,
//                      dataset loading (loadDatasetInto)
//   esn_search.js      the on-node search bar's hidden DOM <input>
//   esn_widget.js      the custom canvas widget (draw + mouse), incl. the
//                      draggable scrollbar of the row list
//   esn_hover.js       DOM hover preview of a drawn row + wheel scrolling
//   esn_dialog.js      the "✎ Easy String Neg Editor" DOM dialog
//   esn_lifecycle.js   setupNode / refreshNode / clearWidgetValuesForFileMode
//
// Only this file registers the extension; the sibling modules are plain
// libraries, so both UIs can keep loading every file under web/ safely.

import { app } from "../../scripts/app.js";
import { NODE_CLASS, state, commitRows } from "./esn_core.js";
import { resizeNode } from "./esn_view.js";
import { setupNode, refreshNode } from "./esn_lifecycle.js";

// ---------------------------------------------------------------------------
// extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "Ghost.EasyStringNegEditor",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_CLASS) return;

    // apply usage-frequency counters that the Python side returns through the
    // "ui" channel after each execution ({"esn_freq": [0, 2, 1, ...]})
    nodeType.prototype.onExecuted = function (message) {
      try {
        const st = this.__esn ? state(this) : null;
        if (!st || !message || !Array.isArray(message.esn_freq)) return;
        const freqs = message.esn_freq;
        if (freqs.length !== st.rows.length) return; // rows changed meanwhile
        let changed = false;
        for (let i = 0; i < freqs.length; i++) {
          const n = Number(freqs[i]);
          const fq = (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
          if ((st.rows[i].freq || 0) !== fq) {
            st.rows[i].freq = fq;
            changed = true;
          }
        }
        if (!changed) return;
        // Silent commit: frequency feedback must not bump data_rev (dataset
        // mode) nor rewrite the rows widget (widget mode) - both would change
        // this node's execution-cache signature and force every downstream
        // node, including KSampler, to re-run on the next Queue even though
        // nothing user-visible changed (a fixed seed would resample from 0).
        // The counters still persist to the dataset file on disk.
        commitRows(this, st.rows, { silent: true }); // counters only
        try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
        resizeNode(this);
      } catch (err) {
        // the frequency feedback is best-effort; never break the graph on it
        console.warn("EasyStringNegEditor: onExecuted freq sync failed", err);
      }
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      setupNode(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      // after a workflow/config restore, python widgets may be fresh —
      // re-run setup (idempotent) and resync our list height
      this.__esnSetupDone = false;
      setupNode(this);
      refreshNode(this);
    };
  },
})

// make sure ComfyUI loads every sibling module even when it only executes the
// entry file; each import above already pulls the modules it needs, so the
// modules below are reachable:
//   esn_core -> esn_view -> (esn_search / esn_widget / esn_dialog / esn_hover)
//   esn_lifecycle -> makeListWidget + installHover + loadDatasetInto
