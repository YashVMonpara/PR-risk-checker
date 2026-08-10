/**
 * Copies the WASM runtime + grammar files that web-tree-sitter needs at runtime
 * into dist/, next to the bundled index.js.
 *
 * A GitHub Action ships as a single pre-built bundle with no `npm install` step,
 * and ncc cannot inline .wasm binaries — so these must be committed alongside it.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const GRAMMARS = ['javascript', 'typescript', 'tsx'];

function copy(from, to) {
  if (!fs.existsSync(from)) {
    throw new Error(`Missing required WASM source: ${from}`);
  }
  fs.copyFileSync(from, to);
  const kb = (fs.statSync(to).size / 1024).toFixed(0);
  console.log(`  copied ${path.basename(to)} (${kb} KB)`);
}

function main() {
  fs.mkdirSync(dist, { recursive: true });
  console.log('Vendoring tree-sitter WASM into dist/:');

  copy(
    path.join(root, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'),
    path.join(dist, 'web-tree-sitter.wasm')
  );

  for (const grammar of GRAMMARS) {
    const file = `tree-sitter-${grammar}.wasm`;
    copy(
      path.join(root, 'node_modules/@vscode/tree-sitter-wasm/wasm', file),
      path.join(dist, file)
    );
  }

  console.log('WASM vendoring complete.');
}

main();
