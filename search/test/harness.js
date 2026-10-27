// Runs an n8n Code-node file (mode: run once for all items) offline with stubbed n8n globals.
const fs = require('fs');
const path = require('path');
const { DateTime, Settings } = require('/opt/homebrew/lib/node_modules/n8n/node_modules/luxon');

const NODES = path.join(__dirname, '..', 'nodes');

function run(file, opts) {
  return runCode(fs.readFileSync(path.join(NODES, file), 'utf8'), opts);
}

function runCode(code, { items = [], nodes = {}, staticData = {}, now } = {}) {
  const src = code.replace(/__CHAT_ID__/g, '111');
  const wrap = (arr) => arr.map((json) => ({ json }));
  const $input = { all: () => wrap(items), first: () => wrap(items)[0] };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`node "${name}" not stubbed`);
    return { all: () => wrap(nodes[name]), first: () => wrap(nodes[name])[0] };
  };
  Settings.now = now ? () => new Date(now).getTime() : () => Date.now();
  const silent = { log: () => {} };
  const out = new Function('$input', '$', '$getWorkflowStaticData', 'DateTime', 'console', src)(
    $input, $, () => staticData, DateTime, silent);
  return out.map((i) => i.json);
}

module.exports = { run, runCode };
