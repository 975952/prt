/** Shared assistant identity and actual request composition; no real user data or API. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const nativeStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const nativeFetch = globalThis.fetch;
const values = new Map([['reader.locale', 'zh-CN']]);
let writes = 0;
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem(key, value) { writes++; values.set(key, String(value)); },
  removeItem: key => values.delete(key),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

try {
  const { AGENT_PROFILE_KEY, DEFAULT_AGENT_PROFILE, readAgentProfile, writeAgentProfile,
    agentDisplayName, buildAgentProfilePrompt } = await import('../public/js/agent-profile.js');
  const { streamChat } = await import('../public/js/ai.js');
  assert.deepEqual(readAgentProfile(), DEFAULT_AGENT_PROFILE);
  assert.equal(writes, 0, 'opening the app must not persist defaults');
  assert.equal(agentDisplayName(), '小林');
  assert.match(buildAgentProfilePrompt(), /Alina（小林）/);
  assert.equal(agentDisplayName({ name: '自定义名字' }), '自定义名字');
  const english = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { agentDisplayName } = await import(${JSON.stringify(new URL('../public/js/agent-profile.js', import.meta.url).href)}); console.log(agentDisplayName());`],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(english.status, 0, english.stderr);
  assert.equal(english.stdout.trim(), 'Alina');
  console.log('PASS: Alina has a localized display name without writing defaults or altering custom names');

  values.set('reader.agent.name', '旧名字');
  assert.equal(readAgentProfile().name, '旧名字');
  values.set(AGENT_PROFILE_KEY, '{broken');
  assert.equal(readAgentProfile().name, '旧名字');
  values.set(AGENT_PROFILE_KEY, JSON.stringify({ habits: '简短回答', unknown: 'discard me' }));
  assert.deepEqual(readAgentProfile(), { ...DEFAULT_AGENT_PROFILE, name: '旧名字', habits: '简短回答' });
  const saved = writeAgentProfile({ name: ' 新名字 ', personality: '认真', gender: '女' });
  assert.deepEqual(saved, { name: '新名字', personality: '认真', gender: '女', habits: '简短回答' });
  assert.deepEqual(JSON.parse(values.get(AGENT_PROFILE_KEY)), saved);
  assert.equal(values.get('reader.agent.name'), '新名字');
  const normalized = writeAgentProfile({ name: '😀'.repeat(40), habits: '', gender: 123, unknown: 'ignored' });
  assert.equal([...normalized.name].length, 32, 'length limits preserve Unicode characters');
  assert.equal(normalized.habits, '', 'users may clear optional preferences');
  assert.equal(normalized.gender, '女', 'invalid partial fields preserve the saved value');
  assert.deepEqual(Object.keys(normalized).sort(), ['gender', 'habits', 'name', 'personality']);
  console.log('PASS: legacy names, malformed storage, partial edits, clearing and Unicode limits are handled');

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage denied'); } });
  assert.deepEqual(readAgentProfile(), DEFAULT_AGENT_PROFILE);
  assert.throws(() => writeAgentProfile({ name: 'unsaved' }), /storage denied/);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    ...storage, setItem() { throw new Error('quota exceeded'); },
  } });
  assert.throws(() => writeAgentProfile({ name: 'unsaved' }), /quota exceeded/);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  assert.notEqual(readAgentProfile().name, 'unsaved');
  console.log('PASS: unavailable or full storage never reports unsaved preferences as saved');

  writeAgentProfile(DEFAULT_AGENT_PROFILE);
  let request, reply = 'A direct answer.';
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const prefix = 'Assistant expression preferences (shared across this application):';
  const tools = [{ type: 'function', function: { name: 'read_page', parameters: { type: 'object', properties: {} } } }];
  const cases = [
    { system: 'Answer the question using the cited paper.', user: 'Explain the result.', reply: 'The paper reports an improvement.〔p.2〕' },
    { system: 'Translate into English. Return the translation only.', user: '你好，世界。', reply: 'Hello, world.' },
    { system: '后台学习记忆提取器。Only output a JSON array following this exact schema.', user: '记住用户偏好。', reply: '[{"preference":"concise"}]' },
    { system: '为这段会话起标题。Output only a short title.', user: 'Summarize the topic.', reply: 'Attention and tokens' },
  ];
  for (const sample of cases) {
    reply = sample.reply;
    const messages = Object.freeze([
      Object.freeze({ role: 'system', content: sample.system }),
      Object.freeze({ role: 'system', content: 'Keep citation markers unchanged.' }),
      Object.freeze({ role: 'user', content: sample.user }),
    ]);
    assert.equal(await streamChat({ messages, stream: false }), sample.reply);
    assert.equal(request.messages.length, messages.length);
    assert.ok(request.messages[0].content.includes(sample.system), 'first task remains detectable in its original system message');
    assert.ok(request.messages[0].content.indexOf(prefix) < request.messages[0].content.indexOf(sample.system), 'specific task rules follow expression preferences');
    assert.equal(request.messages.map(message => message.content).join('\n').split(prefix).length - 1, 1);
    assert.equal(messages[0].content, sample.system, 'caller data remains untouched');
    assert.deepEqual(request.messages.at(-1), messages.at(-1));
    assert.match(request.messages[0].content, /Follow the current task and its specific constraints first/);
    assert.match(request.messages[0].content, /infer no abilities, opinions, behavior, or stereotypes/);
  }
  console.log('PASS: QA, translation, JSON extraction and title requests retain their task and exact output contracts');

  writeAgentProfile({ name: 'Mira', personality: '简洁', habits: '一次只讲一个概念。', gender: '' });
  const followup = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_page', arguments: '{"page":2}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: '{"page":2,"text":"evidence"}' },
  ];
  await streamChat({ messages: followup, tools, stream: false });
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /Mira/);
  assert.doesNotMatch(request.messages[0].content, /Alina（小林）/);
  assert.match(request.messages[0].content, /一次只讲一个概念/);
  assert.deepEqual(request.messages.slice(1), followup);
  assert.deepEqual(request.tools, tools);
  console.log('PASS: edits apply to the next request while tool calls, results and schemas remain intact');
} finally {
  globalThis.fetch = nativeFetch;
  if (nativeStorage) Object.defineProperty(globalThis, 'localStorage', nativeStorage);
  else delete globalThis.localStorage;
}
