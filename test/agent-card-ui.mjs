/** Character design in an isolated browser; no user files or live model calls. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { withChatHarness } from './_chat-harness.mjs';

await withChatHarness({ tag: 'agent-card', papers: [] }, async h => {
  const { page, pass, scratch } = h;
  const input = async (selector, value) => page.$eval(selector, (node, value) => {
    node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('reader.agent.profile.v1') || 'null'));
  const idle = () => page.waitForFunction(() => document.querySelector('#agentProfileForm').getAttribute('aria-busy') === 'false');
  const generateMarker = '只输出 JSON 对象';
  const card = { name: 'Mira', personality: 'Warm but direct', gender: '女', habits: 'Brief answers',
    description: 'A patient study partner', examples: 'User: I am stuck.\nAssistant: Let us try one step.', enabled: true };
  const finishGeneration = async value => {
    await h.waitRequest(generateMarker);
    await h.emit(generateMarker, { text: value, done: true }); await idle();
  };

  await page.waitForSelector('#agentWelcome', { visible: true });
  await page.screenshot({ path: path.join(scratch, 'first-open.png') });
  await page.click('#agentWelcomeSkip');
  assert.equal(await saved(), null);
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$('#agentWelcome'), null);
  pass('first-open invitation can be skipped; reload does not repeat it or create a card');

  await page.evaluate(() => localStorage.removeItem('reader.agent.welcome.v1'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('#agentWelcomeCustomize');
  await page.waitForSelector('#settingsPaneAgent:not(.hidden)', { visible: true });
  assert.equal(await page.$('#agentWelcome'), null);
  assert.equal(await page.$eval('#agentRoleEnabled', node => node.checked), false);
  assert.equal(await page.$eval('#agentNameDisplay', node => node.tagName), 'SPAN');
  assert.equal(await page.$eval('#agentCardBuilder', node => !!node.closest('#settingsPaneAgent')), true);
  pass('Customize opens Settings → Assistant; character mode defaults off and editing stays in Settings');

  await page.click('#agentCardBuilder summary');
  await page.evaluate(async () => { (await import('/js/ai.js')).Settings.data.hasApiKey = false; });
  await page.click('#agentCardAsk');
  assert.match(await page.$eval('#agentCardConversation', node => node.textContent), /what would you like me to help with/);
  assert.equal(await page.evaluate(() => __mockChatRequests.length), 0, 'the first question works without an API key');
  await input('#agentCardInput', 'Help me study.');
  await page.click('#agentCardSend');
  assert.match(await page.$eval('#agentCardConversation', node => node.textContent), /What personality/);
  await page.click('#agentCardGenerate');
  assert.match(await page.$eval('#agentCardConversation', node => node.textContent), /one step before we can chat/);
  assert.equal(await page.$eval('#agentCardStatus', node => node.classList.contains('error')), false);
  assert.equal(await page.evaluate(() => __mockChatRequests.length), 0);
  await page.click('#agentCardConversation button');
  await page.waitForFunction(() => document.activeElement.id === 'cfgApiKey');
  assert.equal(await page.$eval('#settingsPaneModel', node => node.classList.contains('hidden')), false);
  await page.click('#settingsNavAgent');
  await page.click('#agentCardClear');
  await page.evaluate(async () => { (await import('/js/ai.js')).Settings.data.hasApiKey = true; });
  await page.click('#agentCardAsk');
  await input('#agentCardInput', 'PREFERENCE_MARKER: warm but direct, female, brief answers.');
  await page.click('#agentCardSend');
  assert.equal(await page.$$eval('#agentCardConversation .agent-card-message', nodes => nodes.length), 3);
  for (const answer of ['Warm but direct.', 'Mira, female.', 'Brief answers.']) {
    await input('#agentCardInput', answer); await page.click('#agentCardSend');
  }
  assert.equal(await page.$$eval('#agentCardConversation .agent-card-message', nodes => nodes.length), 9);
  assert.equal(await page.evaluate(() => __mockChatRequests.length), 0, 'all interview turns are collected locally');
  pass('the guide asks one question at a time without a key; generation without a key gives a normal reply and settings button');

  await input('#agentCardInput', 'A study partner, please.');
  await page.click('#agentCardGenerate'); await finishGeneration(JSON.stringify(card));
  assert.equal(await page.$eval('#agentNameInput', node => node.value), card.name);
  assert.equal(await page.$eval('#agentRoleEnabled', node => node.checked), false);
  assert.equal(await saved(), null);
  const generation = await page.evaluate(marker => __mockChatRequests.find(r => r.source.includes(marker)).body, generateMarker);
  assert.equal(generation.messages.filter(message => message.role === 'assistant').length, 5);
  assert.equal(await page.evaluate(() => __mockChatRequests.length), 1, 'only Generate sends the collected conversation');
  assert.ok(JSON.stringify(generation.messages).includes('A study partner, please.'));
  assert.ok(!generation.messages[0].content.includes('Assistant expression preferences'));
  pass('generation receives the complete interview plus unsent preferences and only fills an editable draft');

  await page.$eval('#agentRoleEnabled', node => { node.checked = true; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#agentProfileSave'); await idle();
  assert.deepEqual(await saved(), card);
  await page.click('#agentCardGenerate'); await finishGeneration('{broken');
  assert.match(await page.$eval('#agentCardStatus', node => node.textContent), /invalid card/);
  assert.equal(await page.$eval('#agentNameInput', node => node.value), 'Mira');
  assert.deepEqual(await saved(), card);
  pass('explicit Save enables the card; invalid generation preserves both the draft and saved card');

  await page.click('#agentCardGenerate');
  await page.waitForFunction(() => !document.querySelector('#agentCardStop').hidden);
  await page.click('#agentCardStop'); await idle();
  assert.deepEqual(await saved(), card);
  await page.click('#agentCardGenerate'); await finishGeneration(JSON.stringify({ ...card, name: 'Unsaved' }));
  assert.equal(await page.$eval('#agentNameInput', node => node.value), 'Unsaved');
  await page.click('#agentProfileReset');
  assert.equal(await page.$eval('#agentNameInput', node => node.value), 'Mira');
  pass('Stop permits retry and generated changes can be discarded without losing the saved character');

  await page.click('#agentCardGenerate');
  await page.waitForFunction(() => !document.querySelector('#agentCardStop').hidden);
  page.once('dialog', dialog => dialog.accept());
  await page.click('#closeSettings');
  await page.waitForSelector('#settingsModal.hidden');
  await page.click('#settingsBtn'); await page.waitForSelector('#settingsModal:not(.hidden)');
  assert.equal(await page.$eval('#agentNameInput', node => node.value), 'Mira');
  assert.equal(await page.$eval('#agentCardStop', node => node.hidden), true);
  pass('closing Settings cancels design generation and reopening restores the saved card');

  await page.$eval('#agentRoleEnabled', node => { node.checked = false; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#agentProfileSave'); await idle();
  assert.deepEqual(await saved(), { ...card, enabled: false });
  await page.click('#closeSettings');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$('#agentWelcome'), null);
  await page.click('#settingsBtn'); await page.click('#settingsNavAgent');
  assert.equal(await page.$eval('#agentDescriptionInput', node => node.value), card.description);
  assert.equal(await page.$eval('#agentRoleEnabled', node => node.checked), false);
  pass('disabling character mode preserves all card fields across reload without repeating onboarding');

  await page.click('#agentCardBuilder summary');
  await input('#agentCardInput', 'PASTED_CONVERSATION: User: I want a concise study partner.');
  await page.click('#agentCardGenerate'); await finishGeneration(JSON.stringify(card));
  const direct = await page.evaluate(marker => __mockChatRequests.find(r => r.source.includes(marker)).body, 'PASTED_CONVERSATION');
  assert.equal(direct.messages.filter(message => message.role === 'assistant').length, 0);
  assert.equal(await page.$eval('#agentRoleEnabled', node => node.checked), false);
  pass('pasted preferences generate a card directly without completing an interview');
  await page.$eval('.settings-panes', node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(scratch, 'character-card.png') });
  await page.$eval('#agentCardBuilder', node => node.scrollIntoView({ block: 'end' }));
  await page.screenshot({ path: path.join(scratch, 'ai-design.png') });
  await page.setViewport({ width: 360, height: 640 });
  await page.screenshot({ path: path.join(scratch, 'narrow-design.png') });
  assert.equal(await page.$eval('.settings-box', node => node.scrollWidth <= node.clientWidth + 1), true);
  pass('character editor and AI designer fit narrow Settings without horizontal overflow');
});
