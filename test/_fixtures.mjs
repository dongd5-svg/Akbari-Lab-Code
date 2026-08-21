import { readFileSync } from 'fs';
// fixtures/*.js assign a window global; strip the assignment to get the JSON.
export function loadFixture(name) {
  const src = readFileSync(new URL(`../fixtures/${name}.js`, import.meta.url), 'utf8');
  return JSON.parse(src.replace(/^window\.\w+\s*=\s*/, '').replace(/;\s*$/, ''));
}
