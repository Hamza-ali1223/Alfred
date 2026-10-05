'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Chat = require('../desktop/chatcompletions');

const response = chunks => ({
 ok: true,
 body: new ReadableStream({
  start(controller) {
   for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
   controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
   controller.close();
  },
 }),
});

test('conversion preserves message order and content without leaking internal cache metadata', () => {
 const messages = [
  { role: 'system', content: 'stable instructions' },
  { role: 'user', content: 'earlier question', cache: true },
  { role: 'assistant', content: 'earlier answer' },
  { role: 'user', content: 'new question' },
 ];
 assert.deepEqual(Chat.convert(messages, true), [
  { role: 'system', content: 'stable instructions' },
  { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
  { role: 'assistant', content: 'earlier answer' },
  { role: 'user', content: [{ type: 'text', text: 'new question' }] },
 ]);
});

test('normalizes common cache-read and cache-write usage fields', () => {
 assert.deepEqual(Chat.cacheUsage({ prompt_tokens_details: { cached_tokens: 17 }, cache_write_tokens: 3 }), { cached_tokens: 17, written_tokens: 3 });
 assert.deepEqual(Chat.cacheUsage({ input_tokens_details: { cache_read_tokens: 11, cache_creation_tokens: 4 } }), { cached_tokens: 11, written_tokens: 4 });
 assert.deepEqual(Chat.cacheUsage({}), {});
 assert.deepEqual(Chat.cacheUsage({ cached_tokens: -1, written_tokens: '5' }), {});
});

test('adds only the configured stable session cache key and returns cache usage', async () => {
 const originalFetch = global.fetch;
 const calls = [];
 global.fetch = async (url, options) => {
  calls.push({ url, options });
  return response([{ choices: [], usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100, prompt_tokens_details: { cached_tokens: 70 } } }]);
 };
 try {
  const request = { model: 'model-x', key: 'secret', messages: [{ role: 'user', content: 'hello' }], maxTokens: 50, session: 'stable-chat-id' };
  const context = { apiUrl: 'https://provider.example/v1', promptCacheKey: true };
  const result = await Chat.stream(request, context);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.prompt_cache_key, 'stable-chat-id');
  assert.equal(body.messages[0].content[0].text, 'hello');
  assert.equal(result.usage.cached_tokens, 70);

  calls.length = 0;
  await Chat.stream(request, { ...context, promptCacheKey: false });
  assert.equal(Object.hasOwn(JSON.parse(calls[0].options.body), 'prompt_cache_key'), false);
 } finally {
  global.fetch = originalFetch;
 }
});
