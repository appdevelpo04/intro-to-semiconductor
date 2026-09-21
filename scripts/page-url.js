/**
 * page-url.js — resolves the URL of the running demo for the Playwright scripts.
 *
 * The Astro config sets base: '/intro-to-semiconductor/', so in dev the site is
 * NOT at the origin root: http://localhost:4321/ 404s while the real page lives
 * at http://localhost:4321/intro-to-semiconductor/. Every validator used to
 * hard-code the root, decide "no dev server" from that 404, then spawn a second
 * dev server on the already-busy port and die. Probing the known bases (and only
 * spawning when none of them answers) keeps `bun run check` usable locally.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PORT = Number(process.env.PORT || 4321);
const ORIGIN = 'http://localhost:' + PORT;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CANDIDATES = [
  process.env.PAGE_URL,
  ORIGIN + '/intro-to-semiconductor/',
  ORIGIN + '/',
].filter(Boolean);

const up = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
};

const probe = async () => {
  for (const u of CANDIDATES){ if (await up(u)) return u; }
  return null;
};

/* Returns { url, proc } — proc is the dev server we started, or null if one was
   already listening. Throws if nothing comes up within ~30s. */
export async function resolvePageUrl(){
  let url = await probe();
  let proc = null;
  if (!url){
    console.log('no dev server on :' + PORT + ' — starting astro dev …');
    proc = spawn('bun', ['x', 'astro', 'dev', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 60 && !url; i++){
      url = await probe();
      if (!url) await new Promise((r) => setTimeout(r, 500));
    }
    if (!url){ proc.kill(); throw new Error('dev server never came up on :' + PORT); }
  }
  return { url, proc };
}
