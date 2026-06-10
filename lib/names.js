// Name normalization for cross-referencing harvested connections against the
// people you already have message threads with. LinkedIn inbox rows do NOT
// expose profile URLs, so this match is name-based and therefore HEURISTIC —
// used to FLAG ("verify"), never as the sole reliable signal. Normalization is
// aggressive and identical on both sides so trivial formatting differences
// (accents, emoji, honorifics, credential suffixes, First/Last order) don't
// cause misses.

const FOLD = { ß: 'ss', ø: 'o', Ø: 'o', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', æ: 'ae', œ: 'oe', þ: 'th' };
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'professor', 'sir', 'dame', 'rev', 'capt', 'lt', 'sgt', 'col']);
// Conservative: only suffixes very unlikely to be real surnames are stripped as
// bare tokens. Anything after the first comma is already dropped, which handles
// the usual ", MBA" / ", CFA" case without risking surnames like "Ma"/"Ba".
const BARE_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'mba', 'msc', 'mph', 'cfa', 'cpa', 'pmp', 'esq', 'cissp', 'md', 'jd', 'dds', 'edd']);

export function normName(raw) {
  if (!raw) return '';
  // Note: we do NOT cut at the first comma — that would wreck "Last, First"
  // name forms. Credentials after a comma (", MBA"/", CFA") are removed instead
  // by BARE_SUFFIX token-stripping below.
  let s = String(raw);
  s = s.replace(/[ßøØłŁđĐæœþ]/g, (ch) => FOLD[ch] || ch); // fold letters NFD misses
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip accents
  s = s.toLowerCase();
  s = s.replace(/\((?:he|she|they)[^)]*\)/g, ' '); // pronoun parentheticals
  s = s.replace(/[^a-z\s]/g, ' '); // drop emoji/symbols/digits/punct
  let toks = s.split(/\s+/).filter(Boolean);
  while (toks.length && HONORIFICS.has(toks[0])) toks.shift(); // leading honorifics
  toks = toks.filter((t) => !BARE_SUFFIX.has(t) && t !== 'you');
  const multi = toks.filter((t) => t.length > 1); // drop middle initials...
  if (multi.length >= 2) toks = multi; // ...unless that leaves too little
  toks.sort(); // order-insensitive: "First Last" == "Last First"
  return toks.join(' ');
}

// Heuristic group/multi-party detection from a conversation title.
export function isGroupName(title) {
  if (!title) return false;
  return /,| and | & |\+\s*\d|and \d+ other/i.test(title);
}

// Owner set: the account holder, so self/group rows don't get matched. Derived
// from the real name + the live nav display name — NEVER the email or template
// signature.
export function ownerKeySet(...names) {
  return new Set(names.map(normName).filter(Boolean));
}
