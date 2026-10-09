import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Authenticated session hydration through the MCP tool surface.
 *
 * The fixture (`/auth.html`) renders its gated controls from session state, not
 * from a URL parameter: a localStorage token unlocks "account-balance" and a
 * session cookie unlocks "sign-out". So a passing hydration assertion is really
 * "the browser context was seeded before the document started", which no amount
 * of post-load scripting could fake.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = join(root, 'bin', 'navi-mcp.js');

/** @param {any} result @returns {any} */
const envelope = result => JSON.parse(result.content[0].text);

/** @param {any} client */
async function actionIds(client) {
  const map = envelope(await client.callTool({ name: 'navi_get_actions', arguments: { all: true } }));
  const actions = /** @type {any[]} */ (map.actions ?? []);
  return actions.map(action => /** @type {string} */ (action.target_id));
}

test('navi_set_session restores cookies and localStorage so restricted controls become discoverable', async ({ baseURL }) => {
  test.setTimeout(180000);
  const origin = new URL(/** @type {string} */ (baseURL)).origin;
  const page = `${origin}/auth.html`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, NAVI_MCP_DEBUG: '1' }
  });
  const client = new Client({ name: 'navi-mcp-session', version: '1.0.0' });
  await client.connect(transport);
  try {
    // The tool is advertised, and its schema accepts both hydrated shapes.
    const listed = await client.listTools();
    const tool = listed.tools.find(candidate => candidate.name === 'navi_set_session');
    expect(tool, 'navi_set_session must be advertised').toBeTruthy();
    expect(tool?.inputSchema?.type).toBe('object');
    expect(Object.keys(tool?.inputSchema?.properties ?? {})).toEqual(['cookies', 'origins', 'storage_state', 'url']);

    // 1. Anonymous first: without hydration the gated controls do not exist.
    const anonymous = envelope(await client.callTool({ name: 'navi_navigate', arguments: { url: page } }));
    expect(anonymous.ok).toBe(true);
    const anonIds = await actionIds(client);
    expect(anonIds, 'the fixture must be reachable').toContain('sign-in');
    expect(anonIds, 'no session means no gated controls').not.toContain('account-balance');
    expect(anonIds, 'no session means no cookie-gated control').not.toContain('sign-out');

    // 2. Inline hydration with cookies plus per-origin localStorage, navigating in
    //    the same call so the state is applied before the document starts.
    const inline = await client.callTool({
      name: 'navi_set_session',
      arguments: {
        cookies: [{ name: 'navi-session', value: 'cookie-token', url: origin }],
        origins: [{ origin, localStorage: [{ name: 'navi-auth-token', value: 'valid-token' }] }],
        url: page
      }
    });
    expect(inline.isError, JSON.stringify(envelope(inline))).toBeFalsy();
    const hydrated = envelope(inline);
    expect(hydrated.ok).toBe(true);
    expect(hydrated.title).toContain('Navi');
    const hydratedIds = await actionIds(client);
    expect(hydratedIds, 'localStorage hydration unlocks the account control').toContain('account-balance');
    expect(hydratedIds, 'cookie hydration unlocks the cookie-gated control').toContain('sign-out');
    expect(hydratedIds, 'the anonymous control is gone').not.toContain('sign-in');
    // The gated control is real, not just present: drive it.
    expect(envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'account-balance', action_type: 'click' } })).dispatched).toBe(true);
    // Secrets never travel back to the caller.
    expect(JSON.stringify(hydrated)).not.toContain('valid-token');
    expect(JSON.stringify(hydrated)).not.toContain('cookie-token');

    // 3. The same outcome from a Playwright storageState.json file, applied before
    //    navigation — the file is the portable form a CI job would produce.
    const dir = await mkdtemp(join(tmpdir(), 'navi-storage-state-'));
    const file = join(dir, 'storageState.json');
    await writeFile(file, JSON.stringify({
      cookies: [{ name: 'navi-session', value: 'cookie-token', url: origin }],
      origins: [{ origin, localStorage: [{ name: 'navi-auth-token', value: 'valid-token' }] }]
    }, null, 2));
    const fromFile = await client.callTool({ name: 'navi_set_session', arguments: { storage_state: file } });
    expect(fromFile.isError, JSON.stringify(envelope(fromFile))).toBeFalsy();
    expect(envelope(fromFile).hydrated).toEqual({ cookies: 1, origins: 1, localStorage: 1 });
    const navigated = envelope(await client.callTool({ name: 'navi_navigate', arguments: { url: page } }));
    expect(navigated.ok).toBe(true);
    const fileIds = await actionIds(client);
    expect(fileIds).toContain('account-balance');
    expect(fileIds).toContain('sign-out');

    // 4. Bad input is refused with an actionable code instead of crashing or
    //    silently hydrating nothing.
    /** @type {[Record<string, unknown>, string][]} */
    const badSessions = [
      [{}, 'Provide storage_state'],
      [{ storage_state: { cookies: 'nope' } }, 'cookies must be an array'],
      [{ storage_state: join(dir, 'missing.json') }, 'Could not read storageState file'],
      [{ storage_state: { cookies: [{ name: 'x', value: 'y' }] } }, 'url or both domain and path'],
      [{ storage_state: { cookies: [], origins: [{ origin: `${origin}/`, localStorage: [] }] } }, 'bare http(s) origin'],
      [{ origins: [{ origin, localStorage: [{ name: 'a' }] }] }, 'string name and value'],
      [{ storage_state: { cookies: [], origins: [{ origin, localStorage: [] }] } }, 'Nothing to hydrate']
    ];
    for (const [arguments_, expected] of badSessions) {
      const refused = await client.callTool({ name: 'navi_set_session', arguments: arguments_ });
      expect(refused.isError, `refuses ${JSON.stringify(arguments_)}`).toBe(true);
      const body = envelope(refused);
      expect(body.error?.code, JSON.stringify(body)).toBe('INVALID_SESSION');
      expect(body.error?.message).toContain(expected);
    }
    // A refusal must not have mutated the session: the hydrated page still works.
    expect((await actionIds(client)).length, 'the session survives refused input').toBeGreaterThan(1);
  } finally {
    await client.close();
  }
});
