import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { stateNameCodes, targetStatesIn, trustedTargetStates } = await import('../server/services/targetStates.js');
const cimAutomation = await import('../server/services/cimAutomation.js');

const source = (file) => fs.readFileSync(new URL(`../server/services/${file}`, import.meta.url), 'utf8');
const importsOf = (file) => [...source(file).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)]
  .map((match) => match[1]);

test('targetStates is dependency-free and owns the default target state list', () => {
  assert.deepEqual(importsOf('targetStates.js'), []);
  assert.equal(/\bimport\s*\(/.test(source('targetStates.js')), false);
  assert.deepEqual(trustedTargetStates, ['NY', 'CA', 'NJ', 'AZ', 'NV', 'CT']);
  assert.equal(cimAutomation.trustedTargetStates, trustedTargetStates, 'cimAutomation re-exports the same list');
  assert.equal(Object.isFrozen(stateNameCodes), true);
});

test('targetStatesIn reads codes and full names in target-list order', () => {
  assert.deepEqual(targetStatesIn('Phoenix, Arizona or Reno NV'), ['AZ', 'NV']);
  assert.deepEqual(targetStatesIn('new jersey'), ['NJ']);
  assert.deepEqual(targetStatesIn('Austin, TX'), []);
  assert.deepEqual(targetStatesIn('CANADA'), [], 'a code inside a word is not a match');
  assert.deepEqual(targetStatesIn('Scottsdale, AZ', ['AZ', 'NV']), ['AZ']);
});

test('the timezone resolver no longer reaches storage through the criteria profile', () => {
  assert.deepEqual(importsOf('opportunityTimezone.js').sort(), ['./targetStates.js', 'node:crypto']);
  assert.ok(importsOf('dealCriteriaProfile.js').includes('./targetStates.js'));
});
