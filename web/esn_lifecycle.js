// EasyStringNegEditor — node lifecycle (setup / refresh / dataset load).
//
// setupNode wires the hidden python widgets to the custom canvas widget and
// installs the hover/wheel machinery. It retries a bounded number of times
// until the python widgets actually exist (they can appear a tick after
// onNodeCreated). refreshNode re-reads widget values; loadDatasetInto pulls
// rows + presets from a dataset *.json when the node is in file mode.

import { app } from "../../scripts/app.js";
import {
  state, rowsWidget, presetsWidget, widgetRawValue,
  hideRowsWidget, syncFromWidget,
  NODE_CLASS, UI_NAME,
} from "./esn_core.js";
import { resizeNode, loadDatasetInto } from "./esn_view.js";
import { makeListWidget } from "./esn_widget.js";
import { installHover } from "./esn_hover.js";

// ---------------------------------------------------------------------------
// setup (idempotent, retries until python widgets exist)
// ---------------------------------------------------------------------------

function clearWidgetValuesForFileMode(node) {
  const st = state(node);
  if (!st.file) return;
  // dataset mode: keep the serialized workflow small - the widgets only
  // carry the file name; rows/presets live on disk.
  const rw = rowsWidget(node);
  if (rw && widgetRawValue(rw) !== "[]") {
    try { rw.value = "[]"; } catch (e) {}
    try { if (rw.inputEl && typeof rw.inputEl === "object") rw.inputEl.value = "[]"; } catch (e) {}
  }
  const pw = presetsWidget(node);
  if (pw && widgetRawValue(pw) !== "") {
    try { pw.value = ""; } catch (e) {}
    try { if (pw.inputEl && typeof pw.inputEl === "object") pw.inputEl.value = ""; } catch (e) {}
  }
  // only blank the in-memory rows when they belong to a different file
  if (st.loadedFile !== st.file) {
    st.raw = "[]";
    st.rows = [];
    st.presets = "";
    st.loadedFile = null;
  }
}

function setupNode(node) {
  if (!node || node.__esnSetupDone) return;
  if (!node.widgets || !rowsWidget(node)) {
    // python widgets may be created a tick after onNodeCreated on some UIs
    if (!node.__esnRetries) node.__esnRetries = 0;
    if (node.__esnRetries < 200) {
      node.__esnRetries += 1;
      setTimeout(() => setupNode(node), 30);
    }
    return;
  }
  if (node.widgets.some((w) => w && w.name === UI_NAME)) {
    // already added (e.g. reconfigure) — just refresh
    node.__esnSetupDone = true;
    hideRowsWidget(node);
    syncFromWidget(node);
    clearWidgetValuesForFileMode(node);
    loadDatasetInto(node);
    return;
  }
  node.__esnSetupDone = true;
  hideRowsWidget(node);
  syncFromWidget(node);
  clearWidgetValuesForFileMode(node);
  loadDatasetInto(node);
  const widget = makeListWidget(node);
  try {
    if (typeof node.addCustomWidget === "function") {
      node.addCustomWidget(widget);
    } else if (node.widgets) {
      node.widgets.push(widget);
    }
  } catch (err) {
    console.error("EasyStringNegEditor: failed to add widget", err);
    return;
  }
  node.__esnListWidget = widget;
  installHover();
  resizeNode(node);
}

function refreshNode(node) {
  if (!node || node.type !== NODE_CLASS) return;
  syncFromWidget(node);
  loadDatasetInto(node);
  resizeNode(node);
}

export { clearWidgetValuesForFileMode, setupNode, refreshNode };
