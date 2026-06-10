// Run: node test/names.test.mjs
import assert from 'node:assert/strict';
import { normName, isGroupName, ownerKeySet } from '../lib/names.js';

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

console.log('normalization equivalences (should match)');
t('honorific + apostrophe + credential', () => assert.equal(normName("Dr. Jane O'Brien, PhD"), normName("Jane O'Brien")));
t('accents folded', () => assert.equal(normName('José Álvarez'), normName('Jose Alvarez')));
t('First/Last order-insensitive', () => assert.equal(normName('Smith John'), normName('John Smith')));
t('"Last, First" comma form still matches "First Last"', () => assert.equal(normName('Lodha, Manay'), normName('Manay Lodha')));
t('emoji + pronouns stripped', () => assert.equal(normName('Dana Lee 🚀 (she/her)'), normName('Dana Lee')));
t('German ß + umlaut folded', () => assert.equal(normName('Jürgen Weiß'), 'jurgen weiss'));
t('ß → ss', () => assert.equal(normName('Weiß'), 'weiss'));
t('credential tail after comma dropped', () => assert.equal(normName('Sam Patel, MBA, CFA'), normName('Sam Patel')));
t('trailing suffix token dropped', () => assert.equal(normName('Sam Patel III'), normName('Sam Patel')));
t('middle initial ignored', () => assert.equal(normName('Dana O. Smith'), normName('Dana Smith')));

console.log('non-equivalences (should NOT match)');
t('different people, different names', () => assert.notEqual(normName('John Smith'), normName('Jane Smith')));
t('nickname deliberately not expanded (safe miss)', () => assert.notEqual(normName('Bob Jones'), normName('Robert Jones')));

console.log('collision (same name → same key; caller must treat as low-confidence)');
t('two different "John Smith" collapse to one key', () => assert.equal(normName('John Smith'), normName('john  smith')));

console.log('empties');
t('empty stays empty', () => assert.equal(normName(''), ''));
t('symbols-only → empty', () => assert.equal(normName('🚀🚀'), ''));

console.log('group detection');
t('comma title is group', () => assert.equal(isGroupName('Jane Doe, Bob Lee'), true));
t('"and N others" is group', () => assert.equal(isGroupName('Jane Doe and 2 others'), true));
t('single name not group', () => assert.equal(isGroupName('Jane Doe'), false));

console.log('owner set');
t('owner keys built from real names, match self', () => {
  const owner = ownerKeySet('Manay Lodha', '');
  assert.equal(owner.has(normName('Lodha Manay')), true);
  assert.equal(owner.has(normName('Someone Else')), false);
});

console.log(`\n${pass} assertions passed.`);
