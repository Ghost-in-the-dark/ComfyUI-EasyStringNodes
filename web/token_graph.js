// EasyStringTokenGraph — entry point.
//
// Registers the extension for the EasyStringTokenGraph node: a compact token
// strip on the node itself, and a floating graph panel ("which tokens do I use
// most, and which ones go together") that can be docked to a window edge.
//
// The graph lives in a panel rather than on the node on purpose. A canvas node
// widget draws on ComfyUI's SHARED 2D context, and an interactive force layout
// with hover, panning and a tooltip is far too much surface for that: every
// unbalanced save()/restore() there corrupts the graph renderer for every node
// drawn afterwards (see the canvas balance tests). The panel owns its own
// <canvas>, so the graph can be as interactive as it needs to be while the
// node widget stays a cheap, balanced strip.
//
// Modules:
//   tg_tokens.js   tokenizer + counting, mirroring esn_tokens.py (parity-tested)
//   tg_layout.js   force-directed layout, hit testing, label fitting
//   tg_panel.js    the floating/docked panel: graph, ranking, relations, exclude drawer
//   tg_widget.js   the compact on-node strip

import { app } from "../../scripts/app.js";
import {
  NODE_CLASS, openPanel, closePanel, isPanelOpen, acceptPayload, applyDock,
} from "./tg_panel.js";
import { makeTokenWidget } from "./tg_widget.js";
import { hideTextWidget, unhideTextWidget } from "./esn_core.js";

// The panel must follow the window when it is docked, and it must not survive
// the page outliving its nodes; both listeners are installed once.
let windowHooked = false;

function hookWindow() {
  if (windowHooked) return;
  windowHooked = true;
  window.addEventListener("resize", () => {
    const graph = app.graph;
    if (!graph || !Array.isArray(graph._nodes)) return;
    for (const node of graph._nodes) {
      if (node && node.type === NODE_CLASS && isPanelOpen(node)) applyDock(node);
    }
  });
}

function setupTokenNode(node) {
  if (!node || node.type !== NODE_CLASS) return;
  if (node.__tgSetupDone) return;
  if (!node.widgets || !node.widgets.length) {
    // the python widgets can appear a tick after onNodeCreated
    if (!node.__tgRetries) node.__tgRetries = 0;
    if (node.__tgRetries < 200) {
      node.__tgRetries += 1;
      setTimeout(() => setupTokenNode(node), 30);
    }
    return;
  }
  node.__tgSetupDone = true;
  let widget = null;
  try {
    widget = makeTokenWidget(node);
    if (typeof node.addCustomWidget === "function") node.addCustomWidget(widget);
    else node.widgets.push(widget);
  } catch (err) {
    console.error("EasyStringTokenGraph: failed to add the token strip widget", err);
    return;
  }
  node.__tgWidget = widget;
  // The exclude list is a 50-line multiline widget by default. Left visible it
  // claims hundreds of pixels of node body, pushing the token strip to the very
  // bottom and leaving a tall empty block in the middle of the node - and the
  // list is edited in the panel anyway. Collapse it to zero height, exactly the
  // way the pack's other node hides its data widgets.
  hideExcludeWidget(node);
  // Give the node a sane initial size so the strip and the panel trigger are
  // both reachable without resizing by hand.
  try {
    const min = node.computeSize ? node.computeSize() : null;
    if (min) node.size = [Math.max(node.size[0], 300), Math.max(node.size[1], min[1])];
  } catch (e) {}
  // remember where the panel was left, and restore it
  if (node.properties && node.properties.__tgPanelOpen) {
    try {
      openPanel(node);
    } catch (e) {}
  }
}

// The `exclude` widget stays in the workflow (it is the node's real input and
// must keep round-tripping) but is not shown: the panel edits it, and a
// multiline widget with fifty default lines would otherwise dominate the node.
function hideExcludeWidget(node) {
  const w = (node.widgets || []).find((x) => x && x.name === "exclude");
  if (!w) return false;
  hideTextWidget(w);
  node.__tgExcludeHidden = true;
  return true;
}

// The panel's "exclusions" drawer is the editor for that input, so the widget
// has to be reachable for a workflow that wants to edit it in the node body
// after all; this restores it (used by tests and by any UI that wants it back).
function showExcludeWidget(node) {
  const w = (node.widgets || []).find((x) => x && x.name === "exclude");
  if (!w) return false;
  unhideTextWidget(w);
  node.__tgExcludeHidden = false;
  return true;
}

function hookNode(node) {
  if (!node || node.type !== NODE_CLASS) return;
  const toggle = () => {
    const open = isPanelOpen(node) ? (closePanel(node), false) : (openPanel(node), true);
    if (node.properties) node.properties.__tgPanelOpen = open;
  };
  // double-clicking the node title opens the graph: the discoverable path,
  // since a canvas node offers no standard place for a button
  const prevDbl = node.onDblClick;
  node.onDblClick = function () {
    prevDbl?.apply(this, arguments);
    toggle();
  };
  // Ctrl/Cmd+click on the node also toggles, for a graph-focus workflow
  const prevDown = node.onMouseDown;
  node.onMouseDown = function (e, pos) {
    const handled = prevDown?.apply(this, arguments);
    if (e && (e.ctrlKey || e.metaKey)) {
      toggle();
      return true;
    }
    return handled;
  };
}

app.registerExtension({
  name: "Ghost.EasyStringTokenGraph",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_CLASS) return;

    // The run hands the panel the exact counts for the text it just analysed.
    nodeType.prototype.onExecuted = function (message) {
      try {
        if (!message || !Array.isArray(message.esn_token_graph)) return;
        const payload = message.esn_token_graph[0];
        if (!payload || typeof payload !== "object") return;
        acceptPayload(this, payload);
        // a run refreshes the node strip even when the panel is closed
        try {
          app.graph?.setDirtyCanvas?.(true, true);
        } catch (e) {}
      } catch (err) {
        console.warn("EasyStringTokenGraph: onExecuted payload failed", err);
      }
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      hookWindow();
      setupTokenNode(this);
      hookNode(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      this.__tgSetupDone = false;
      setupTokenNode(this);
      hookNode(this);
      if (this.properties && this.properties.__tgPanelOpen) {
        try {
          openPanel(this);
        } catch (e) {}
      }
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      // a deleted node must not leave a floating window behind
      try {
        if (isPanelOpen(this)) closePanel(this);
      } catch (e) {}
      onRemoved?.apply(this, arguments);
    };
  },
});

// Exported so tests/tg_exclude_hidden.mjs can assert the collapse without
// running a browser: the widget must end up zero-height while keeping its
// value, because the panel reads and writes that same input.
export { hideExcludeWidget, showExcludeWidget, setupTokenNode };
