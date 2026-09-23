/**
 * math.js — LaTeX + Markdown rendering for every DOM formula in the demo.
 *
 *  - texHTML(tex, display) → cached KaTeX HTML (math is rendered over and
 *    over — slider moves repaint the status bar — so results are memoized)
 *  - mdHTML(md) → marked-parsed markdown with `$…$` / `$$…$$` math segments
 *    swapped for KaTeX BEFORE markdown runs, so characters like `*` and `_`
 *    inside TeX can never be mangled into emphasis
 *  - renderMathIn(root) → one-shot boot helper: fills `[data-tex]` and
 *    `[data-md]` elements (static content living in Schottky.astro)
 *
 * Canvas-drawn labels can't use HTML/KaTeX — they keep their unicode
 * formatting in render.js.
 */
import katex from 'katex';
import { marked } from 'marked';

marked.setOptions({ breaks: false, gfm: true });

const texCache = new Map();
const CACHE_CAP = 600;             // bounded: dynamic status-bar values fill it last

export function texHTML(tex, display = false) {
  /* Refuse anything that is not TeX text. KaTeX rejects non-strings with a
     TypeError BEFORE throwOnError can soften it, and a single stray call (an
     element whose data-tex attribute was missing) aborted its whole caller —
     that is how the Fermi modal lost its scroll lock and its card refresh. */
  if (typeof tex !== 'string' || tex === '') return '';
  const key = (display ? 'D:' : 'I:') + tex;
  let html = texCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      output: 'html',
    });
    if (texCache.size < CACHE_CAP) texCache.set(key, html);
  }
  return html;
}

const MATH_TOKEN = '@@TEX@@';
export function mdHTML(md) {
  if (md == null) return '';          // undefined would parse to the text "undefined"
  const parts = [];
  // pull math out first (display $$…$$ wins over inline $…$)
  const guarded = String(md).replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g,
    (m, disp, inl) => {
      parts.push(texHTML(disp !== undefined ? disp : inl, disp !== undefined));
      return MATH_TOKEN + (parts.length - 1) + '@@';
    });
  let html = marked.parse(guarded);
  // marked leaves the placeholder text alone; splice the KaTeX back in
  html = html.replace(/@@TEX@@(\d+)@@/g, (m, i) => parts[+i]);
  return html;
}

/* one-shot: static markup in the .astro file declares its math declaratively */
export function renderMathIn(root) {
  if (!root) return;
  root.querySelectorAll('[data-tex]').forEach((el) => {
    el.innerHTML = texHTML(el.dataset.tex, el.dataset.texMode === 'display');
  });
  root.querySelectorAll('[data-md]').forEach((el) => {
    el.innerHTML = mdHTML(el.dataset.md);
  });
}