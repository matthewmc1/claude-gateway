// Money input: integer cents only. Text is parsed with a strict grammar and never coerced into some other number.
export type MoneyParse = { ok: true; cents: number } | { ok: false; error: string | null };   // error null = blank, nothing to complain about yet

export const MAX_DOLLARS = 100000;
export const MAX_CENTS = MAX_DOLLARS * 100;

/**
 * Paste clean-up. Only removes things that cannot change the amount: whitespace, invisible characters, a leading "$", and
 * thousands separators that are in valid positions ("1,000.50"). Anything else stays so the validator can show it as an error.
 */
export function sanitizeMoneyInput(raw: string): string {
  let s = raw.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim();   // invisible characters and surrounding blanks go; spaces INSIDE the amount stay so '1 000' is rejected, not read as 1000
  s = s.replace(/^\$+\s*/, '');
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, '');
  return s;
}

export function parseMoney(text: string, opts: { max?: number; allowZero?: boolean } = {}): MoneyParse {
  const s = sanitizeMoneyInput(text);
  if (s === '') return { ok: false, error: null };
  if (/^[-−–]/.test(s)) return { ok: false, error: 'Amounts cannot be negative.' };
  if (/\s/.test(s)) return { ok: false, error: 'No spaces inside the amount, for example 1000 or 1000.50.' };
  if (/^(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(s)) return { ok: false, error: 'Write the amount out in full, for example 1000. Scientific notation such as 1e3 is not accepted.' };
  if (/^0[xX]/.test(s)) return { ok: false, error: 'Digits only, for example 12.50.' };
  if (!/^\d*\.?\d*$/.test(s)) return { ok: false, error: 'Digits only, with an optional decimal point, for example 12.50.' };
  if (!/\d/.test(s)) return { ok: false, error: 'Enter an amount, for example 12.50.' };
  const [whole = '', frac = ''] = s.split('.');
  if (frac.length > 2) return { ok: false, error: 'At most 2 decimal places (cents).' };
  if (whole.length > 9) return { ok: false, error: 'That amount is too large.' };
  const cents = (whole === '' ? 0 : parseInt(whole, 10)) * 100 + (frac === '' ? 0 : parseInt(frac.padEnd(2, '0'), 10));
  const max = (opts.max ?? MAX_DOLLARS) * 100;
  if (cents > max) return { ok: false, error: `The most you can enter is $${(max / 100).toLocaleString('en-US')}.` };
  if (cents === 0 && opts.allowZero === false) return { ok: false, error: 'Enter an amount above zero.' };
  return { ok: true, cents };
}

/** "50", "12.50", "1000.05": text for an input field, from integer cents. No grouping so it parses back to the same value. */
export function centsToText(cents: number): string {
  const c = Math.round(cents), whole = Math.floor(c / 100), rest = c % 100;
  return rest ? `${whole}.${String(rest).padStart(2, '0')}` : String(whole);
}
/** Dollars for the API payload (`usd`), exactly cents / 100 with no float arithmetic on the way in. */
export const centsToUsd = (cents: number): number => Number(centsToText(cents));

/** Positive duration in days: digits with at most 2 decimals. Returns the number or an error. */
export function parseDays(text: string): { ok: true; days: number } | { ok: false; error: string | null } {
  const s = text.trim();
  if (/\s/.test(s)) return { ok: false, error: 'No spaces inside the number.' };
  if (s === '') return { ok: false, error: null };
  if (/^[-−–]/.test(s)) return { ok: false, error: 'Days cannot be negative.' };
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return { ok: false, error: 'Digits only, for example 5 or 0.5.' };
  const [whole = '', frac = ''] = s.split('.');
  if (frac.length > 2) return { ok: false, error: 'At most 2 decimal places.' };
  if (whole.length > 4) return { ok: false, error: 'That is too many days.' };
  const days = Number(s);
  if (!(days > 0)) return { ok: false, error: 'Enter more than zero days.' };
  return { ok: true, days };
}
