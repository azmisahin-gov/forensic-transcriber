'use strict';

/**
 * Theme and accent preference handling. UMD so the renderer and the tests share
 * the exact same validation and attribute logic.
 *
 * The appearance is stored as two document-root attributes:
 *   data-theme  = light | dark
 *   data-accent = blue | teal | indigo
 *
 * Light is the default. The renderer persists the choice through the local
 * preferences API; this module only owns the allowed values and the DOM write,
 * so a bad stored value can never leave the UI in an unstyled state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../shared/constants.js'));
  } else {
    root.FT_THEME = factory(root.FT_CONSTANTS);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (constants) {
  if (!constants) throw new Error('theme.js requires FT_CONSTANTS (check script load order)');

  const { THEME_VALUES, ACCENT_VALUES } = constants;
  const DEFAULT_THEME = 'light';
  const DEFAULT_ACCENT = 'blue';

  function normalizeTheme(value) {
    return THEME_VALUES.includes(value) ? value : DEFAULT_THEME;
  }

  function normalizeAccent(value) {
    return ACCENT_VALUES.includes(value) ? value : DEFAULT_ACCENT;
  }

  /**
   * Apply the appearance to a document root. `root` defaults to the current
   * document so the renderer can call it with no arguments; tests pass a stub.
   */
  function apply(root, { theme, accent } = {}) {
    const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
    if (!el) return { theme: normalizeTheme(theme), accent: normalizeAccent(accent) };
    const t = normalizeTheme(theme);
    const a = normalizeAccent(accent);
    el.setAttribute('data-theme', t);
    el.setAttribute('data-accent', a);
    return { theme: t, accent: a };
  }

  return {
    DEFAULT_THEME,
    DEFAULT_ACCENT,
    THEME_VALUES,
    ACCENT_VALUES,
    normalizeTheme,
    normalizeAccent,
    apply,
  };
});
