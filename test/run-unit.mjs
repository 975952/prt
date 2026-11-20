/** Portable, dependency-free checks used by contributors and GitHub Actions. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const suites = ['agent-unit.mjs', 'ai-stream.mjs', 'task-deadline.mjs', 'pdf-lifecycle.mjs', 'paper-access.mjs', 'paper-target.mjs', 'chat-source.mjs', 'session-lifecycle.mjs', 'session-regeneration.mjs', 'reading-source.mjs', 'output-flow.mjs', 'composer-drafts.mjs',
  'translation-queue.mjs', 'paper-titles.mjs', 'paper-organizer.mjs', 'paper-organizer-ai.mjs', 'paper-organizer-flat.mjs', 'organizer-history.mjs', 'selection-reading-order.mjs', 'pdf-reading-theme.mjs', 'i18n.mjs', 'prompts-manifest.mjs', 'repository-check.mjs'];
suites.unshift('agent-profile.mjs');
suites.unshift('import-queue.mjs');
for (const suite of suites) {
  console.log(`\nRunning ${suite}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, suite)], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`\nPASS ${suites.length} check suites`);
