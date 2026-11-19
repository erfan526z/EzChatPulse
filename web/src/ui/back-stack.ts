/**
 * Hardware/browser back inside the app.
 *
 * On a phone the back gesture used to leave the app: the client never touched
 * history, so "back" from an open conversation went straight to whatever was
 * before the app. Every full-screen layer now pushes one history entry and
 * closes itself when that entry is popped, so back walks:
 *
 *   conversation → list → (then) out of the app
 *
 * Layers are pushed by UI code that owns its own close function, so the same
 * mechanism covers the drawer, settings, group info and modal overlays.
 */

interface Layer {
  id: number;
  close: () => void;
  /** cleared when the layer closed itself; a later pop must skip it */
  open: boolean;
}

const layers: Layer[] = [];
let seq = 0;
/** set while we pop a history entry ourselves, so we ignore our own popstate */
let selfPop = 0;

function onPopState(): void {
  if (selfPop > 0) {
    selfPop--;
    return;
  }
  // close every layer that already closed itself, then the topmost live one
  while (layers.length) {
    const layer = layers.pop()!;
    if (layer.open) {
      layer.open = false;
      layer.close();
      return;
    }
  }
}

let installed = false;
function ensureListener(): void {
  if (installed) return;
  window.addEventListener('popstate', onPopState);
  installed = true;
}

/**
 * Register a layer that the back button should close.
 * Returns a function to call when the layer closes *itself* (chevron, scrim,
 * Escape) so its history entry is dropped instead of accumulating.
 */
export function pushBackLayer(close: () => void): () => void {
  ensureListener();
  const id = ++seq;
  const layer: Layer = { id, close, open: true };
  layers.push(layer);
  history.pushState({ backLayer: id }, '');

  return () => {
    if (!layer.open) return;
    layer.open = false;
    const i = layers.findIndex((l) => l.id === id);
    if (i !== -1) layers.splice(i, 1);
    // consume the entry we pushed — but only if it is still the current one;
    // if a deeper layer sits on top of it, the pop will skip this layer instead
    if ((history.state as { backLayer?: number } | null)?.backLayer === id) {
      selfPop++;
      history.back();
    }
  };
}

/** Number of layers currently on the back stack (used by checks). */
export function backLayerCount(): number {
  return layers.filter((l) => l.open).length;
}
