import assert from 'node:assert/strict';
import { MemoryPersistence } from '../packages/tagent-core/src/persistence.js';
import { createSearchSettingsRoutes, SearchSettingsStore } from '../packages/tagent-server/src/search-settings.js';

// Manual opt-in only. The public probe never reads or writes the user's settings.
if (!process.argv.includes('--confirm-public-query')) {
  throw new Error('This probe sends the fixed public query "AI agent research" to Parallel. Run with --confirm-public-query only after approving this outbound test. It does not save settings or call a model.');
}
const persistence = new MemoryPersistence();
const store = await SearchSettingsStore.open(persistence, {});
const app = createSearchSettingsRoutes(store);
const before = store.view();
const response = await app.request('http://localhost/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'parallel', confirmed: true, confirmationVersion: before.confirmationVersion }),
});
assert.equal(response.status, 200);
const result = await response.json();
assert.deepEqual(store.view(), before, 'Probe must not change active settings');
assert.equal(await persistence.load('research-search', null), null, 'Probe must not persist a choice');
assert.equal(result.query, before.testQuery);
assert.equal(result.provider, 'parallel');
console.log(JSON.stringify({ isolatedMemoryStore: true, settingsUnchanged: true, ...result }));
assert.equal(result.status, 'available', 'This is a failed real search probe, not a passing fixture');
