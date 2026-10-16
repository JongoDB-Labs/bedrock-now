// Which model a session runs: always one named in full (bedrock-now's id, e.g. claude-haiku-5-5). Given one of Claude
// Code's aliases (haiku, sonnet, opus) Claude Code picks the model itself — with "haiku" it plans on Sonnet (its "haiku
// plan upgrade") — so what you picked and what it bills would differ. The backend refuses aliases too.
import type { BnModels } from './api';

const ALIAS = /^(haiku|sonnet|opus|fable|opusplan|best|default)(\[1m\])?$/i;

export const isAlias = (m: string): boolean => ALIAS.test(m.trim());

/** The full id for a model the page or you name: an alias becomes the model bedrock-now maps it to (`aliases` of
 *  /.bn/models), an id stays as it is. '' when it is an alias bedrock-now does not map (or nothing). */
export function fullModel(name: string | null | undefined, bn: BnModels | null | undefined): string {
  const m = (name ?? '').trim();
  if (!m) return '';
  if (!isAlias(m)) return m;
  const to = bn?.aliases?.[m.toLowerCase()] ?? bn?.models.find((x) => x.alias === m.toLowerCase())?.id ?? '';
  return to && !isAlias(to) ? to : '';
}

/** Whether a model a frame reports is the one picked (ids compared loosely: a provider may report a longer form). */
export function sameModel(reported: string, picked: string): boolean {
  const a = reported.trim().toLowerCase(), b = picked.trim().toLowerCase();
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

/** The models a turn ran on that are not the one picked (nothing when the pick is unknown). */
export function otherModels(ran: string[] | undefined, picked: string | undefined): string[] {
  return picked ? (ran ?? []).filter((m) => !sameModel(m, picked)) : [];
}

/** "/model NAME" typed as a prompt: the model it names, when bedrock-now serves it (by id, alias or display name) —
 *  the page switches to it by its full id instead of sending the command; null otherwise (it goes to Claude Code). */
export function modelCommand(prompt: string, bn: BnModels | null | undefined): string | null {
  const m = /^\/model\s+(\S[^\n]*?)\s*$/.exec(prompt.trim());
  if (!m || !bn) return null;
  const want = m[1].toLowerCase();
  const id = fullModel(want, bn);
  const hit = bn.models.find((x) => x.id.toLowerCase() === (id || want).toLowerCase() || x.name.toLowerCase() === want);
  return hit ? hit.id : null;
}
