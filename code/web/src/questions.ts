// AskUserQuestion: Claude asks up to four questions, each with a few options (single or multiple choice). The page
// answers through the SDK's own channel (permission {decision: "answer", answers: {"<question text>": "<label(s)>"}}):
// the tool's input comes back with those answers, as Claude Code's own question dialog fills it. Keys must be the
// question text exactly as Claude sent it (the backend accepts only that tool's own questions); several labels of a
// multiple-choice question are joined with ", "; "Other" sends what you typed instead of a label.
import { label } from './text';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

export interface QOption {
  /** the label exactly as sent (what the answer carries) */
  value: string;
  /** shown: one line, capped, bidi/control characters made visible */
  label: string;
  description: string;
}
export interface Question {
  /** the question exactly as sent (the answer's key) */
  key: string;
  text: string;
  header: string;
  multi: boolean;
  options: QOption[];
}

/** What a person picked for one question. */
export interface Pick {
  chosen: number[];
  other: boolean;
  otherText: string;
}
export const emptyPick = (): Pick => ({ chosen: [], other: false, otherText: '' });

/** Control characters the backend refuses in an answer (tab and newline are fine). */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
export const MAX_ANSWER = 2000;

export function parseQuestions(input: unknown): Question[] {
  const qs = Array.isArray(obj(input).questions) ? (obj(input).questions as unknown[]) : [];
  const out: Question[] = [];
  for (const q of qs.slice(0, 4).map(obj)) {
    if (typeof q.question !== 'string' || !q.question || q.question.length > 2000) continue;
    const options = (Array.isArray(q.options) ? (q.options as unknown[]) : [])
      .slice(0, 8)
      .map(obj)
      .filter((o) => typeof o.label === 'string' && o.label.length > 0 && o.label.length <= 500)
      .map((o) => ({ value: (o.label as string).replace(CONTROL, ''), label: label(o.label, 120), description: label(o.description, 300) }));
    out.push({ key: q.question, text: label(q.question, 500), header: label(q.header, 40), multi: q.multiSelect === true, options });
  }
  return out;
}

/** The answer of one question, or null while it has none (an empty "Other" is no answer). */
export function answerOf(q: Question, p: Pick): string | null {
  const labels = p.chosen.filter((i) => i >= 0 && i < q.options.length).map((i) => q.options[i].value);
  const other = p.other ? p.otherText.replace(CONTROL, ' ').trim() : '';
  if (p.other && !other && !labels.length) return null;
  const parts = q.multi ? [...labels, ...(other ? [other] : [])] : other ? [other] : labels.slice(0, 1);
  if (!parts.length) return null;
  return parts.join(', ').slice(0, MAX_ANSWER);
}

/** {question: answer} for all questions, or null until every one has an answer. */
export function buildAnswers(qs: Question[], picks: Pick[]): Record<string, string> | null {
  if (!qs.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < qs.length; i++) {
    const a = answerOf(qs[i], picks[i] ?? emptyPick());
    if (a === null) return null;
    out[qs[i].key] = a;
  }
  return out;
}

/** A click on option i (or on "Other": i = -1) of a question. */
export function toggle(q: Question, p: Pick, i: number): Pick {
  if (i === -1) return q.multi ? { ...p, other: !p.other } : { chosen: [], other: true, otherText: p.otherText };
  if (!q.multi) return { chosen: [i], other: false, otherText: p.otherText };
  return { ...p, chosen: p.chosen.includes(i) ? p.chosen.filter((x) => x !== i) : [...p.chosen, i].sort((a, b) => a - b) };
}
