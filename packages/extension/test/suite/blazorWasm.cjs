// Blazor WebAssembly e2e (runTest.mjs scenario "blazor-wasm") on a temp copy of tests/fixtures/BlazorWasm: the app is a
// runnable target; Run starts the development server (index.html and the framework files are served) and opens the
// browser URL; Debug starts the server and then the browser session of VS Code's JavaScript debugger with the app's
// debugging proxy (no browser in CI: the configuration is checked).
const assert = require('node:assert/strict');
const http = require('node:http');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');

  function get(url) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    });
  }

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 240000);
    return waitFor(async () => ((await a.run.refresh()).some((t) => t.label === 'BlazorClient' && t.runnable) ? a : undefined), 'BlazorClient runnable', 60000);
  }

  const target = (a) => a.run.targets().find((x) => x.label === 'BlazorClient');

  return [
    [
      'blazor-wasm: Run starts the development server; index.html and the framework are served; the browser URL is opened; Stop ends it',
      async () => {
        const a = await ready();
        const t = target(a);
        assert.equal(t.kindLabel, 'Blazor WebAssembly app');
        await a.run.select(t, { profile: 'http', configuration: 'Debug' });
        a.run.hooks.openedUrls.length = 0;
        const session = await a.run.run(t.id);
        try {
          await waitFor(() => /Now listening on: http:\/\/localhost:5285/.test(session.output), 'Now listening on', 300000);
          const page = await get('http://localhost:5285/');
          assert.equal(page.status, 200);
          assert.match(page.body, /<div id="app">/);
          await waitFor(() => a.run.hooks.openedUrls.includes('http://localhost:5285'), 'the browser URL', 10000);
        } finally {
          a.run.stop(t.id);
        }
        await Promise.race([session.done, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not stop')), 30000))]);
      },
    ],
    [
      'blazor-wasm: Debug starts the server, then a js-debug browser session through the Blazor debugging proxy',
      async () => {
        const a = await ready();
        const t = target(a);
        a.run.hooks.browserDebugConfigurations.length = 0;
        assert.equal(await a.run.debug(t.id), true);
        try {
          const cfg = await waitFor(() => a.run.hooks.browserDebugConfigurations[0], 'the browser debug configuration', 300000);
          assert.match(cfg.type, /^pwa-(chrome|msedge)$/);
          assert.equal(cfg.request, 'launch');
          assert.equal(cfg.url, 'http://localhost:5285');
          assert.equal(cfg.inspectUri, '{wsProtocol}://{url.hostname}:{url.port}/_framework/debug/ws-proxy?browser={browserInspectUri}');
          assert.match(cfg.webRoot.replace(/\\/g, '/'), /BlazorClient\/wwwroot$/);
          const proxy = await get('http://localhost:5285/_framework/debug');
          assert.equal(proxy.status, 200, 'the debugging proxy page is served');
        } finally {
          a.run.stop(t.id);
        }
      },
    ],
  ];
};
