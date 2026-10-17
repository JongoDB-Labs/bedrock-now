// Which model a session runs: always one named in full (bedrock-now's id, e.g. claude-haiku-5-5). Given one of Claude
// Code's aliases (haiku, sonnet, opus) Claude Code picks the model itself — with "haiku" it plans on Sonnet (its "haiku
// plan upgrade") — so what you picked and what it bills would differ. The backend refuses aliases too.
import type { BnModels } from './api';
import type { BnModel, Compat } from './types';

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

// ---------------------------------------------------------------- the model picker: groups, search, compatibility


/** What a compatibility status says: a short badge, a sentence, and whether picking it deserves a warning. */
export const COMPAT_INFO: Record<Compat, { badge: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; says: string; warn: boolean }> = {
  works: { badge: 'works', tone: 'ok', says: 'Checked: a Claude Code turn with a tool call round-trips through LiteLLM.', warn: false },
  'chat-only': { badge: 'chat only', tone: 'warn', says: 'It answers, but cannot use tools: Claude Code cannot read, edit or run anything with it.', warn: true },
  fails: { badge: 'fails', tone: 'bad', says: 'A Claude Code session on it fails.', warn: true },
  untested: { badge: 'not tested', tone: 'muted', says: 'Not checked with Claude Code: tool use, thinking and prompt caching may not work.', warn: true },
};

/** The groups of the model picker, in order. */
export const MODEL_GROUPS = ['starred', 'anthropic', 'bedrock', 'or-free', 'or-paid'] as const;
export type ModelGroup = (typeof MODEL_GROUPS)[number];
export const GROUP_TITLE: Record<ModelGroup, string> = {
  starred: 'Starred',
  anthropic: 'Anthropic (Claude)',
  bedrock: 'Other providers on Bedrock',
  'or-free': 'OpenRouter: free',
  'or-paid': 'OpenRouter',
};

const isAnthropic = (m: BnModel): boolean => m.vendor.toLowerCase() === 'anthropic' && m.provider !== 'OpenRouter';

/** Which group a model belongs in (starred aside). */
export function groupOf(m: BnModel): Exclude<ModelGroup, 'starred'> {
  if (m.provider === 'OpenRouter') return m.free ? 'or-free' : 'or-paid';
  return isAnthropic(m) ? 'anthropic' : 'bedrock';
}

/** The text a search looks through: id, name, vendor, provider, the badge, and "free". */
function haystack(m: BnModel): string {
  return `${m.id} ${m.name} ${m.vendor} ${m.provider} ${COMPAT_INFO[m.compat].badge}${m.free ? ' free' : ''}`.toLowerCase();
}

/** Whether a model matches a search: every word of it somewhere (case-insensitive). */
export function modelMatches(m: BnModel, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return true;
  const h = haystack(m);
  return words.every((w) => h.includes(w));
}

/** The picker's sections: starred first, then by provider (Anthropic, Bedrock's others, OpenRouter's free, then paid).
 *  Without `all` only the models Settings lists, and none that fails; the current model is always there. */
export function modelSections(models: BnModel[], o: { query?: string; starred?: string[]; all?: boolean; current?: string }): { group: ModelGroup; models: BnModel[] }[] {
  const starred = new Set(o.starred ?? []);
  const shown = models.filter((m) => m.id === o.current || (o.all ? true : m.listed && m.compat !== 'fails')).filter((m) => modelMatches(m, o.query ?? ''));
  const out: { group: ModelGroup; models: BnModel[] }[] = [];
  const stars = shown.filter((m) => starred.has(m.id));
  if (stars.length) out.push({ group: 'starred', models: stars });
  for (const g of MODEL_GROUPS.slice(1) as Exclude<ModelGroup, 'starred'>[]) {
    const list = shown.filter((m) => !starred.has(m.id) && groupOf(m) === g);
    if (list.length) out.push({ group: g, models: list });
  }
  return out;
}

/** How many models "Show all" would add. */
export function hiddenCount(models: BnModel[]): number {
  return models.filter((m) => !m.listed || m.compat === 'fails').length;
}

/** The model the session reports: an exact id first, then a looser match (a provider may report a longer form), never
 *  a shorter id that only prefixes it ("…-it" for "…-it:free"). */
export function findModel(models: BnModel[], current: string): BnModel | undefined {
  if (!current) return undefined;
  return (
    models.find((m) => m.id === current) ??
    models.find((m) => m.alias === current) ??
    models.filter((m) => current.startsWith(m.id) && !/^[:/]/.test(current.slice(m.id.length))).sort((a, b) => b.id.length - a.id.length)[0]
  );
}

/** A warning for a switch to this model, or null when it works. */
export function compatWarning(m: BnModel): string | null {
  if (!COMPAT_INFO[m.compat].warn) return null;
  const note = m.note && m.note !== COMPAT_INFO[m.compat].says ? ` ${m.note}` : '';
  return `${m.name}: ${COMPAT_INFO[m.compat].says}${note}`;
}
