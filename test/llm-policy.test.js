import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeepSeek } from '../src/llm.js';

test('only Flash is allowed, including when a stale environment requests Pro', () => {
  for (const model of ['deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-chat', 'claude-opus-4']) {
    assert.throws(() => makeDeepSeek({ apiKey: 'test', model }), /Flash/);
  }
  assert.throws(() => makeDeepSeek({ apiKey: 'test', baseUrl: 'https://attacker.example' }), /官方/);
});
test('Flash calls bound output, disable thinking, and reject redirects', async () => {
  let req;
  const llm = makeDeepSeek({ apiKey: 'test', fetchImpl: async (url, opts) => {
    req = { url, ...opts, body: JSON.parse(opts.body) };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] });
  }});
  assert.equal(await llm('hello'), 'OK');
  assert.equal(req.body.model, 'deepseek-flash');
  assert.equal(req.body.max_tokens, 4096);
  assert.deepEqual(req.body.thinking, { type: 'disabled' });
  assert.equal(req.redirect, 'error');
  assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
});
test('oversized input and truncated output never enter published content', async () => {
  let calls = 0;
  const llm = makeDeepSeek({ apiKey: 'test', fetchImpl: async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] });
  }});
  await assert.rejects(llm('x'.repeat(100001)), /过长/);
  assert.equal(calls, 0);
  await assert.rejects(llm('hello'), /截断/);
});
