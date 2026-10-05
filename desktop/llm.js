'use strict';

// Requests to OpenAI and Anthropic run here in the main process: the Codex backend and the ChatGPT sign-in are out of reach of the page.
// The page starts a run by id and gets its deltas, then the result or the error, back as events.
const { app, ipcMain } = require('electron');
const OpenAI = require('./openai');
const Claude = require('./anthropic');
const ChatGPT = require('./chatgpt');
const Chat = require('./chatcompletions');

const KIMCHI_MODELS = [
 { id: 'deepseek-v4-flash-0731', name: 'DeepSeek-V4-Flash-0731', context: 1048576, vision: false },
 { id: 'kimi-k2.7', name: 'Kimi-K2.7', context: 262144, vision: true },
 { id: 'minimax-m3', name: 'MiniMax-M3', context: 1048576, vision: true },
 { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context: 1048576, vision: true },
 { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1048576, vision: true },
];

const KIMCHI_CONFIG = {
 apiUrl: 'https://llm.kimchi.dev/openai/v1',
 headers: { 'User-Agent': 'kimchi/0.1.48' },
 extraBody: { enable_thinking: true },
 preset: KIMCHI_MODELS,
};

const COMMANDCODE_CONFIG = {
 apiUrl: 'http://127.0.0.1:8787/v1',
 headers: {},
 extraBody: {},
 preset: undefined,
};

const runs = new Map();
const PROVIDERS = new Set(['openai', 'chatgpt', 'anthropic', 'kimchi', 'commandcode']);
const CUSTOM_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const customProviders = new Map();

function cleanCustomProviders(list) {
 if (!Array.isArray(list)) return null;
 const next = new Map();
 for (const item of list) {
  if (!item || !CUSTOM_ID.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || typeof item.baseUrl !== 'string') return null;
  let url;
  try { url = new URL(item.baseUrl); } catch { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !local) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, '').endsWith('/v1')) return null;
  next.set(item.id, { id: item.id, name: item.name.trim().slice(0, 80), baseUrl: url.href.replace(/\/$/, '') });
 }
 return next;
}

const known = provider => PROVIDERS.has(provider) || customProviders.has(provider);
const engineFor = provider => CUSTOM_ID.test(provider) ? Chat : engine(provider);

const engine = provider => {
 if (provider === 'anthropic') return Claude;
 if (provider === 'kimchi' || provider === 'commandcode') return Chat;
 return OpenAI;
};

async function start(sender, id, request) {
 const controller = new AbortController();
 runs.set(id, controller);
 const send = data => { if (!sender.isDestroyed()) sender.send('llm:event', { id, ...data }); };
 console.log(`[LLM:start] Provider: ${request?.provider}, Model: ${request?.model}`);
 try {
  if (!known(request?.provider)) throw new Error('Unknown provider');
  const custom = customProviders.get(request.provider);
  const isKimchi = request.provider === 'kimchi';
  const isCommandCode = request.provider === 'commandcode';
  const result = await engineFor(request.provider).stream(request, {
   signal: controller.signal,
   onEvent: send,
   chatgpt: ChatGPT.credentials,
   version: app.getVersion(),
   apiUrl: custom?.baseUrl || (isKimchi ? KIMCHI_CONFIG.apiUrl : isCommandCode ? COMMANDCODE_CONFIG.apiUrl : undefined),
   headers: isKimchi ? KIMCHI_CONFIG.headers : isCommandCode ? COMMANDCODE_CONFIG.headers : undefined,
   extraBody: isKimchi ? KIMCHI_CONFIG.extraBody : isCommandCode ? COMMANDCODE_CONFIG.extraBody : undefined,
  });
  console.log(`[LLM:done] Request ${id} completed successfully.`);
  send({ type: 'done', result });
 } catch (error) {
  const aborted = controller.signal.aborted || error.name === 'AbortError';
  if (!aborted) console.error(`[LLM:error] Request ${id} failed:`, error.message, error.status || '');
  send({ type: 'error', aborted, status: error.status || 0, code: error.code || '', message: aborted ? '' : error.message });
 } finally {
  runs.delete(id);
 }
}

function register(fromApp) {
 ipcMain.on('llm:start', (event, id, request) => { if (fromApp(event)) start(event.sender, id, request); });
 ipcMain.on('llm:abort', (event, id) => { if (fromApp(event)) runs.get(id)?.abort(); });
 ipcMain.handle('llm:custom-providers', (event, list) => {
  if (!fromApp(event)) return false;
  const next = cleanCustomProviders(list);
  if (!next) return false;
  customProviders.clear();
  for (const [id, item] of next) customProviders.set(id, item);
  return true;
 });
 ipcMain.handle('llm:models', async (event, provider, key, apiUrl) => {
  if (!fromApp(event) || !known(provider)) return { models: [] };
  const custom = customProviders.get(provider);
  const isKimchi = provider === 'kimchi';
  const isCommandCode = provider === 'commandcode';
  try {
   return {
    models: await engineFor(provider).models(
     { provider, key, apiUrl: custom?.baseUrl || (isKimchi ? KIMCHI_CONFIG.apiUrl : isCommandCode ? COMMANDCODE_CONFIG.apiUrl : undefined), headers: isKimchi ? KIMCHI_CONFIG.headers : isCommandCode ? COMMANDCODE_CONFIG.headers : undefined, preset: isKimchi ? KIMCHI_CONFIG.preset : isCommandCode ? COMMANDCODE_CONFIG.preset : undefined },
     { chatgpt: ChatGPT.credentials, version: app.getVersion() }
    )
   };
  } catch (error) {
   return { error: { status: error.status || 0, code: error.code || '', message: error.message } };
  }
 });
 const auth = action => async event => {
  if (!fromApp(event)) return { connected: false };
  try {
   return await action();
  } catch (error) {
   return { ...(await ChatGPT.status()), error: error.message };
  }
 };
 ipcMain.handle('auth:login', auth(() => ChatGPT.login()));
 ipcMain.handle('auth:logout', auth(() => ChatGPT.logout()));
 ipcMain.handle('auth:status', auth(() => ChatGPT.status()));
 ipcMain.handle('auth:cancel', auth(async () => { ChatGPT.cancel(); return ChatGPT.status(); }));
 ipcMain.handle('auth:limits', async event => {
  if (!fromApp(event)) return null;
  try {
   return { limits: await ChatGPT.limits() };
  } catch (error) {
   return { error: error.message, status: error.status || 0 };
  }
 });
}

function cancelAll() {
 for (const controller of runs.values()) controller.abort();
 ChatGPT.cancel();
}

module.exports = { register, cancelAll };
