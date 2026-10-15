import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const c = (id) => ({ type: 'oauth', access: `access-${id}`, refresh: `refresh-${id}`, expires: 9999999999999, accountId: id });
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function withExtension(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-auto-test-'));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    const original = readFileSync(join(base, '../src/index.ts'), 'utf8');
    writeFileSync(join(dir, 'index.ts'), original.replace('"@earendil-works/pi-coding-agent"', '"./mock-pi.mjs"'));
    copyFileSync(join(base, '../src/rotation.ts'), join(dir, 'rotation.ts'));
    copyFileSync(join(base, 'mock-pi.mjs'), join(dir, 'mock-pi.mjs'));
    const { default: extension } = await import(pathToFileURL(join(dir, 'index.ts')).href);
    const authPath = join(dir, 'auth.json');
    const storePath = join(dir, 'codex-accounts.json');
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': c('a'), anthropic: { type: 'api_key', key: 'unchanged' } }));
    writeFileSync(storePath, JSON.stringify({ accounts: {
      alpha: { credential: c('a'), savedAt: 1 },
      beta: { credential: c('b'), savedAt: 2 },
      gamma: { credential: c('c'), savedAt: 3 },
    }, active: 'alpha' }));
    const handlers = new Map(); const commands = new Map(); const notices = []; let reloads = 0;
    extension({ on: (name, h) => handlers.set(name, h), registerCommand: (name, cmd) => commands.set(name, cmd) });
    const ctx = {
      model: { provider: 'openai-codex', id: 'gpt-5.6-codex' },
      ui: { notify: (txt, level) => notices.push({txt, level}) },
      reload: async () => { reloads++; },
    };
    const fail = (id) => ({ message: { role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 429 rate_limit_exceeded' }, messageEntryId: id });
    await fn({dir,handlers,commands,ctx,fail,notices,getReloads:()=>reloads,authPath,storePath});
  } finally {
    if(oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('quota error rotates active identity, preserves other provider and returns valid recovery drafts', async () => {
  await withExtension(async ({ handlers,ctx,fail,authPath,storePath }) => {
    await handlers.get('before_agent_start')({messageType:'user'});
    await handlers.get('turn_end')(fail('failed-1'), ctx);
    assert.equal(json(authPath)['openai-codex'].accountId, 'b');
    assert.equal(json(authPath).anthropic.key, 'unchanged');
    assert.equal(json(storePath).active, 'beta');
    const resume = handlers.get('agent_before_settle')({ outcome: 'error', context: { contextMessages: [{ role:'user',content:'hello' }] } },ctx);
    assert.equal(resume.continue, true);
    assert.deepEqual(resume.entries[0], {type:'context_edit',targetId:'failed-1',replacement:null});
    assert.equal(resume.entries[1].type,'custom_message');
    assert.equal(resume.entries[1].display,false);
  });
});

test('never rotates when request was unauthorized instead of quota-limited', async () => {
  await withExtension(async ({ handlers,ctx,authPath,fail }) => {
    const evt = fail('f-unauth');
    evt.message.errorMessage='401 Unauthorized';
    await handlers.get('turn_end')(evt,ctx);
    assert.equal(json(authPath)['openai-codex'].accountId,'a');
    assert.equal(handlers.get('agent_before_settle')({outcome:'error',context:{contextMessages:[{role:'user'}]}},ctx),undefined);
  });
});

test('bounded retry chain: all other accounts tried once then stop', async () => {
  await withExtension(async ({ handlers,ctx,fail,authPath }) => {
    for (const id of ['failure-1','failure-2','failure-3']) {
      await handlers.get('turn_end')(fail(id),ctx);
      handlers.get('agent_before_settle')({outcome:'error',context:{contextMessages:[{role:'user'}]}},ctx);
    }
    assert.equal(json(authPath)['openai-codex'].accountId,'c');
    assert.equal(handlers.get('agent_before_settle')({outcome:'error',context:{contextMessages:[{role:'user'}]}},ctx),undefined);
  });
});

test('native successful retry cancels extension continuation', async () => {
  await withExtension(async ({ handlers,ctx,fail }) => {
    await handlers.get('turn_end')(fail('failed-1'),ctx);
    await handlers.get('turn_end')({message:{role:'assistant',stopReason:'stop'}},ctx);
    assert.equal(handlers.get('agent_before_settle')({outcome:'completed',context:{contextMessages:[{role:'user'}]}},ctx),undefined);
  });
});

test('manual /codex-auto next reloads, toggle disables automatic switching', async () => {
  await withExtension(async ({ handlers,commands,ctx,fail,authPath,getReloads }) => {
    const cmd = commands.get('codex-auto').handler;
    await cmd('off',ctx);
    await handlers.get('turn_end')(fail('f-off'),ctx);
    assert.equal(json(authPath)['openai-codex'].accountId,'a');
    await cmd('next',ctx);
    assert.equal(json(authPath)['openai-codex'].accountId,'b');
    assert.equal(getReloads(),1);
  });
});

// Regression: Pi does not export the AuthStorage class. The extension must
// work with only the public readStoredCredential() helper available.
test('status works without importing the internal AuthStorage class', async () => {
  await withExtension(async ({ commands, ctx, notices }) => {
    await commands.get('codex-auto').handler('status', ctx);
    assert.match(notices.at(-1).txt, /active=alpha/);
    assert.doesNotMatch(notices.at(-1).txt, /Cannot read properties of undefined/);
  });
});

test('corrupt auth.json is not overwritten during a manual rotation', async () => {
  await withExtension(async ({ commands, ctx, authPath, notices }) => {
    writeFileSync(authPath, '{not valid JSON');
    await commands.get('codex-auto').handler('next', ctx);
    assert.equal(readFileSync(authPath, 'utf8'), '{not valid JSON');
    assert.ok(notices.some(n => /Switch failed|No unused|No active/.test(n.txt)));
  });
});
