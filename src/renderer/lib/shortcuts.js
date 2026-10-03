'use strict';

/**
 * Central shortcut registry.
 *
 * One place defines every keyboard action and its default binding, so the
 * in-app shortcut list, the key handler and the foot-pedal mapping all agree.
 * A foot pedal (or any HID device that types keys) is supported by letting the
 * operator rebind three "pedal" actions to whatever keys their device emits —
 * no device-specific code and no dependency.
 *
 * UMD so the same file loads in the renderer and under Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FT_SHORTCUTS = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // action -> { label, keys (default primary), alt (alternate bindings) }
  const DEFINITIONS = Object.freeze({
    'play-pause': { label: 'Oynat / Duraklat', keys: [' '], code: true },
    'seek-back': { label: 'Geri sar', keys: ['ArrowLeft'] },
    'seek-forward': { label: 'İleri sar', keys: ['ArrowRight'] },
    'prev-segment': { label: 'Önceki bölüm', keys: ['Alt+ArrowLeft'] },
    'next-segment': { label: 'Sonraki bölüm', keys: ['Alt+ArrowRight'] },
    'prev-bookmark': { label: 'Önceki işaret', keys: ['Alt+ArrowUp'] },
    'next-bookmark': { label: 'Sonraki işaret', keys: ['Alt+ArrowDown'] },
    'next-unreviewed': { label: 'Sonraki incelenmemiş', keys: ['Alt+U'] },
    'next-unclear': { label: 'Sonraki belirsiz', keys: ['Alt+N'] },
    save: { label: 'Kaydet', keys: ['Ctrl+S', 'Meta+S'] },
    search: { label: 'Ara', keys: ['Ctrl+F', 'Meta+F'] },
    undo: { label: 'Geri al', keys: ['Ctrl+Z', 'Meta+Z'] },
    redo: { label: 'Yinele', keys: ['Ctrl+Shift+Z', 'Meta+Shift+Z'] },
    bookmark: { label: 'İşaret koy', keys: ['Ctrl+B', 'Meta+B'] },
    edit: { label: 'Seçili bölümü düzenle', keys: ['F2'] },
    stop: { label: 'Durdur / İptal', keys: ['Escape'] },
    'loop-segment': { label: 'Bölümü döngüde oynat', keys: ['Ctrl+L', 'Meta+L'] },
  });

  const DEFAULT_PEDALS = Object.freeze({ 1: 'ArrowLeft', 2: ' ', 3: 'ArrowRight' });

  /** Normalise a KeyboardEvent into the "Ctrl+Shift+Key" form used above. */
  function eventToKeys(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.metaKey) parts.push('Meta');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    let key = event.key;
    if (key === ' ') key = ' ';
    if (key && key.length === 1) key = key.toUpperCase();
    // The space key is special-cased; others keep their canonical form.
    if (event.code === 'Space') key = ' ';
    parts.push(key);
    return parts.join('+');
  }

  /**
   * Build the action -> binding lookup. `overrides` maps an action to a binding
   * string (used by the pedal mapping and any future custom profiles).
   */
  function buildBindings({ overrides = {}, pedals = DEFAULT_PEDALS } = {}) {
    const byBinding = new Map();
    const add = (binding, action) => {
      if (!binding) return;
      if (!byBinding.has(binding)) byBinding.set(binding, action);
    };
    for (const [action, def] of Object.entries(DEFINITIONS)) {
      for (const key of def.keys) add(key, action);
    }
    // Overrides win over defaults.
    for (const [action, binding] of Object.entries(overrides)) {
      if (binding) add(binding, action);
    }
    // Pedal bindings map to three canonical actions.
    if (pedals) {
      add(pedals[1], 'seek-back');
      add(pedals[2], 'play-pause');
      add(pedals[3], 'seek-forward');
    }
    return byBinding;
  }

  /** The shortcut help rows for the in-app list. */
  function shortcutHelp(overrides = {}) {
    return Object.entries(DEFINITIONS).map(([action, def]) => ({
      action,
      label: def.label,
      binding: overrides[action] || def.keys[0],
    }));
  }

  return { DEFINITIONS, DEFAULT_PEDALS, eventToKeys, buildBindings, shortcutHelp };
});
