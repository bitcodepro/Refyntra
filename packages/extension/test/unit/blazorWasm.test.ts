import { describe, expect, it } from 'vitest';
import { BLAZOR_INSPECT_URI, blazorWasmBrowserConfiguration, isWebKind, kindLabel, parseLaunchSettings } from '../../src/runModel';

describe('Blazor WebAssembly run and debug', () => {
  it('is a web kind (browser URL, ASPNETCORE_ENVIRONMENT) with its own label', () => {
    expect(isWebKind('blazor-wasm')).toBe(true);
    expect(isWebKind('web')).toBe(true);
    expect(isWebKind('console')).toBe(false);
    expect(kindLabel('blazor-wasm')).toBe('Blazor WebAssembly app');
  });

  it('reads the inspectUri of a launch profile', () => {
    const profiles = parseLaunchSettings(JSON.stringify({ profiles: { http: { commandName: 'Project', launchBrowser: true, inspectUri: 'ws://x/{browserInspectUri}', applicationUrl: 'http://localhost:5285' } } }));
    expect(profiles[0]).toMatchObject({ name: 'http', inspectUri: 'ws://x/{browserInspectUri}', launchBrowser: true });
  });

  it('debugs in Edge on Windows and Chrome elsewhere through the debugging proxy', () => {
    const win = blazorWasmBrowserConfiguration('http://localhost:5285', undefined, 'C:\\src\\BlazorClient', 'win32');
    expect(win).toMatchObject({ type: 'pwa-msedge', request: 'launch', url: 'http://localhost:5285', inspectUri: BLAZOR_INSPECT_URI, webRoot: 'C:\\src\\BlazorClient/wwwroot' });
    const linux = blazorWasmBrowserConfiguration('http://localhost:5285', { name: 'http', environmentVariables: {}, launchBrowser: true, inspectUri: 'custom' }, '/src/BlazorClient/', 'linux');
    expect(linux).toMatchObject({ type: 'pwa-chrome', inspectUri: 'custom', webRoot: '/src/BlazorClient/wwwroot' });
  });
});
