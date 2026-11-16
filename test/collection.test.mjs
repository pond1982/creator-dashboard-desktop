import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('collection and original dance stay local and link out safely', async () => {
 const page=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 assert(page.includes('https://pond1982.github.io/bangkok-sky-zero/'));
 assert(page.includes('https://github.com/pond1982/creator-dashboard-desktop'));
 for(const name of ['เรื่องในเงา','เล่าเห็นภาพ','อดีตถึงวันนี้']) assert(page.includes('https://www.youtube.com/@'+name));
 assert(page.includes('data-pondd-character'));
 const code=await readFile(new URL('../public/pondd-character.js',import.meta.url),'utf8');
 assert(code.includes("const MODEL = '/pondd.glb'"));
 assert(!code.includes('https://'));
 assert(code.includes("import('./pondd-three.js')"));
});
