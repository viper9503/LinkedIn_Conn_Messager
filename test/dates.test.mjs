// Run: node test/dates.test.mjs
import assert from 'node:assert/strict';
import {
  parseCaption, toYMD, keepCard, isOlderThan, labelOf, extractCompany, firstNameOf, shiftDays,
} from '../lib/dates.js';

const NOW = [2026, 6, 7]; // matches the project "today"
const CUTOFF = toYMD(2026, 5, 24);
const STOP = toYMD(...shiftDays([2026, 5, 24], -2)); // 2-day margin => 2026-05-22

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
const abs = (text, dt = null) => parseCaption(text, dt, NOW);

console.log('absolute dates');
t('US "Connected on May 24, 2026"', () => assert.deepEqual(abs('Connected on May 24, 2026'), { kind: 'abs', ymd: 20260524 }));
t('no-"on" "Connected May 24, 2026"', () => assert.deepEqual(abs('Connected May 24, 2026'), { kind: 'abs', ymd: 20260524 }));
t('non-US "24 May 2026"', () => assert.deepEqual(abs('Connected on 24 May 2026'), { kind: 'abs', ymd: 20260524 }));
t('abbrev "Jan 3, 2026"', () => assert.deepEqual(abs('Connected on Jan 3, 2026'), { kind: 'abs', ymd: 20260103 }));
t('Spanish "24 de mayo de 2026"', () => assert.deepEqual(abs('En contacto desde el 24 de mayo de 2026'), { kind: 'abs', ymd: 20260524 }));
t('French "24 mai 2026"', () => assert.deepEqual(abs('Connecté le 24 mai 2026'), { kind: 'abs', ymd: 20260524 }));
t('datetime attr is authoritative', () => assert.deepEqual(abs('whatever', '2026-05-30T12:00:00.000Z'), { kind: 'abs', ymd: 20260530 }));

console.log('relative — points');
t('today', () => assert.deepEqual(abs('Connected today'), { kind: 'abs', ymd: 20260607 }));
t('yesterday', () => assert.deepEqual(abs('Connected yesterday'), { kind: 'abs', ymd: 20260606 }));
t('3 days ago', () => assert.deepEqual(abs('Connected 3 days ago'), { kind: 'abs', ymd: 20260604 }));
t('"5m" is MINUTES => today (not months)', () => assert.deepEqual(abs('5m'), { kind: 'abs', ymd: 20260607 }));
t('"2h" => today', () => assert.deepEqual(abs('2h'), { kind: 'abs', ymd: 20260607 }));

console.log('relative — ranges (coarse buckets)');
t('"2 weeks ago" is a range', () => assert.deepEqual(abs('Connected 2 weeks ago'), { kind: 'range', newest: 20260527, oldest: 20260521 }));
t('"2mo" badge => months range', () => assert.deepEqual(abs('2mo'), { kind: 'range', newest: toYMD(...shiftDays([2026, 4, 7], 15)), oldest: toYMD(...shiftDays([2026, 4, 7], -15)) }));

console.log('month-subtraction clamp (no setMonth rollover)');
t('Mar 31 − 1 month clamps to Feb 28', () => {
  // "1 month ago" from 2026-03-31 should center on Feb 28, never Mar 03.
  assert.deepEqual(parseCaption('Connected 1 month ago', null, [2026, 3, 31]),
    { kind: 'range', newest: toYMD(...shiftDays([2026, 2, 28], 15)), oldest: toYMD(...shiftDays([2026, 2, 28], -15)) });
});

console.log('unknown / skeleton');
t('bare "Connected" => unknown', () => assert.deepEqual(abs('Connected'), { kind: 'unknown' }));
t('empty => unknown', () => assert.deepEqual(abs(''), { kind: 'unknown' }));

console.log('keep / stop decisions (cutoff 2026-05-24 inclusive, stop thresh 2026-05-22)');
t('boundary May 24 is KEPT (inclusive, no tz off-by-one)', () => assert.equal(keepCard(abs('Connected on May 24, 2026'), CUTOFF), true));
t('May 23 not kept, but NOT old enough to stop (margin)', () => {
  const p = abs('Connected on May 23, 2026');
  assert.equal(keepCard(p, CUTOFF), false);
  assert.equal(isOlderThan(p, STOP), false);
});
t('May 10 triggers stop', () => assert.equal(isOlderThan(abs('Connected on May 10, 2026'), STOP), true));
t('"2 weeks ago" kept, never triggers stop', () => {
  const p = abs('Connected 2 weeks ago');
  assert.equal(keepCard(p, CUTOFF), true);
  assert.equal(isOlderThan(p, STOP), false);
});
t('"2 months ago" excluded and triggers stop', () => {
  const p = abs('Connected 2 months ago');
  assert.equal(keepCard(p, CUTOFF), false);
  assert.equal(isOlderThan(p, STOP), true);
});
t('unknown is kept and never stops', () => {
  assert.equal(keepCard({ kind: 'unknown' }, CUTOFF), true);
  assert.equal(isOlderThan({ kind: 'unknown' }, STOP), false);
});

console.log('labels');
t('abs label', () => assert.equal(labelOf(abs('Connected on May 24, 2026')), '2026-05-24'));
t('range label flagged approx', () => assert.equal(labelOf(abs('Connected 2 weeks ago')), '≈ 2026-05-27 (approx)'));

console.log('company / name extraction');
t('"Eng at Acme" => Acme', () => assert.equal(extractCompany('Software Engineer at Acme'), 'Acme'));
t('"@ Acme" => Acme', () => assert.equal(extractCompany('PM @ Acme Corp'), 'Acme Corp'));
t('trailing clause trimmed', () => assert.equal(extractCompany('Engineer at Acme — we are hiring'), 'Acme'));
t('no separator => null', () => assert.equal(extractCompany('Open to work'), null));
t('hyphenated company kept', () => assert.equal(extractCompany('Engineer at Hewlett-Packard'), 'Hewlett-Packard'));
t('firstName', () => assert.equal(firstNameOf('Dana O. Smith 🚀'), 'Dana'));

console.log(`\n${pass} assertions passed.`);
