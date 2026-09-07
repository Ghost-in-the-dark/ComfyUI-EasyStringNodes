// EasyStringNegEditor — on-node search input.
//
// The node-level search bar draws on the canvas but its text editing uses a
// single off-screen DOM <input> (focused on demand) so the graph keyboard
// shortcuts keep working while typing. Kept in its own module because both
// the canvas widget (esn_widget.js) and the dialog (esn_dialog.js) touch it.

import { app } from "../../scripts/app.js";
import { state } from "./esn_core.js";

// --- on-node search (hidden DOM <input> focused on demand) ---
let searchInput = null;
let searchNode = null; // node currently being searched

function ensureSearchInput() {
  if (searchInput && searchInput.parentNode) return searchInput;
  searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.setAttribute("autocomplete", "off");
  searchInput.setAttribute("spellcheck", "false");
  Object.assign(searchInput.style, {
    position: "fixed", left: "0", top: "0", width: "1px", height: "1px",
    opacity: "0", border: "0", padding: "0", margin: "0", outline: "none",
    zIndex: "-1", pointerEvents: "none",
  });
  searchInput.addEventListener("input", () => {
    const st = searchNode ? state(searchNode) : null;
    if (st) {
      st.search = searchInput.value || "";
      app.graph?.setDirtyCanvas?.(true, true);
    }
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clearSearch();
      e.stopPropagation();
    } else if (e.key === "Enter") {
      e.stopPropagation();
    } else {
      // keep graph hotkeys from firing while typing
      e.stopPropagation();
    }
  });
  searchInput.addEventListener("blur", () => {
    const st = searchNode ? state(searchNode) : null;
    if (st) st.searchFocus = false;
    app.graph?.setDirtyCanvas?.(true, true);
  });
  searchInput.addEventListener("focus", () => {
    const st = searchNode ? state(searchNode) : null;
    if (st) st.searchFocus = true;
    app.graph?.setDirtyCanvas?.(true, true);
  });
  document.body.appendChild(searchInput);
  return searchInput;
}

function focusSearch(node) {
  searchNode = node;
  const inp = ensureSearchInput();
  const st = state(node);
  if (window.__ESN_DEBUG) {
    console.log("[ESN-search] focusSearch node=" + (node.title || node.type) +
      " inputInDom=" + !!(inp && inp.parentNode) +
      " searchFocusWas=" + st.searchFocus +
      " activeEl=" + (document.activeElement === inp ? "input" : String(document.activeElement && document.activeElement.tagName)));
  }
  if (st.searchFocus) {
    // already focused: keep focus and select-all so typing replaces the text
    inp.focus();
    inp.select();
    if (window.__ESN_DEBUG) console.log("[ESN-search] was focused: re-focus+select, now active=" + (document.activeElement === inp));
    return;
  }
  inp.value = st.search || "";
  st.searchFocus = true;
  inp.focus();
  inp.select();
  if (window.__ESN_DEBUG) console.log("[ESN-search] focused, now active=" + (document.activeElement === inp) + " val='" + inp.value + "'");
}

function clearSearch() {
  const st = searchNode ? state(searchNode) : null;
  if (searchInput) searchInput.value = "";
  if (st) {
    st.search = "";
    st.searchFocus = false;
    if (searchInput) searchInput.blur();
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

export { searchInput, focusSearch, clearSearch, blurActiveSearch };

function blurActiveSearch() {
  if (searchInput && document.activeElement === searchInput) {
    try { searchInput.blur(); } catch (e) {}
  }
}
