// static/answers.js's pure parts: what each picker offers — the Terminal tab's (Claude Code on Bedrock, a shell, your
// AI subscriptions' tools, greyed with why when they cannot open here) and the Chat tab's (Open WebUI, Bedrock and
// OpenRouter models, your API keys next, the tools themselves, the subscriptions as Chat models greyed with the
// provider's reason) — the terminal's address with the pickers' words, and the saved choice read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, plain } from "./load.mjs";

const A = load("answers.js").bnAnswers._pure;
const tools = [
  { id: "claude", name: "Claude Code", provider: "Anthropic", plan: "your Claude plan", command: "claude-sub", installed: true, signed_in: "yes", kind_words: "Claude Max", chat_model: "no", chat_why: "Coming next." },
  { id: "codex", name: "Codex", provider: "OpenAI", plan: "your ChatGPT plan", command: "codex", installed: true, signed_in: "no", kind_words: "", chat_model: "no", chat_why: "Terms first." },
  { id: "copilot", name: "GitHub Copilot CLI", provider: "GitHub", plan: "your Copilot plan", command: "copilot", installed: true, signed_in: "unknown", kind_words: "", chat_model: "no", chat_why: "No." },
  { id: "cursor", name: "Cursor CLI", provider: "Cursor", plan: "your Cursor plan", command: "cursor-agent", installed: false, signed_in: "no", kind_words: "", chat_model: "no", chat_why: "No." },
  { id: "grok", name: "Grok Build", provider: "xAI", plan: "SuperGrok", command: "grok", installed: null, signed_in: "unknown", kind_words: "", chat_model: "no", chat_why: "No." },
];
const data = { terminal: { here: true }, basics: [{ id: "bedrock", name: "Claude Code (Bedrock)", command: "claude-bedrock" }, { id: "shell", name: "A shell", command: "bash" }],
  tools, models: [{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "Bedrock" }, { id: "or/x", label: "X", provider: "OpenRouter" }] };

test("the Terminal tab: Bedrock and a shell, then each tool with its state; one that cannot open is greyed with why", () => {
  const g = plain(A.terminalOptions(data));
  assert.deepEqual(g.map((x) => x.items.map((i) => i.value)), [["bedrock", "shell"], ["claude", "codex", "copilot", "cursor", "grok"]]);
  const by = Object.fromEntries(g[1].items.map((i) => [i.value, i]));
  assert.equal(by.claude.label, "Claude Code (claude-sub) · signed in · Claude Max");
  assert.equal(by.codex.label, "Codex (codex) · sign in first");
  assert.equal(by.copilot.label, "GitHub Copilot CLI (copilot) · /user in it says who");
  assert.equal(by.grok.label, "Grok Build (grok) · not checked yet");
  assert.equal(by.cursor.disabled, true);
  assert.match(by.cursor.title, /TERMINAL_AI_TOOLS/);
  // the terminal off on this site (remote access without REMOTE_TERMINAL): everything greyed, said why
  const off = plain(A.terminalOptions({ ...data, terminal: { here: false } }));
  assert.ok(off.every((x) => x.items.every((i) => i.disabled)));
  assert.match(off[1].items[0].title, /REMOTE_TERMINAL/);
});

test("the Chat tab: Open WebUI first, the models, your keys next, the tools themselves, and the subscriptions as models greyed", () => {
  const g = plain(A.chatOptions(data));
  assert.deepEqual(g.map((x) => x.label), ["", "Bedrock", "OpenRouter", "Your API keys", "Your AI subscriptions — the tool itself, here", "Your AI subscriptions as Chat models"]);
  assert.equal(g[0].items[0].value, "owui");
  assert.deepEqual(g[1].items.map((i) => i.value), ["model:claude-haiku-5-5"]);
  assert.equal(g[3].items[0].disabled, true);
  assert.deepEqual(g[4].items.map((i) => [i.value, i.disabled]), [["tool:claude", false], ["tool:codex", false], ["tool:copilot", false], ["tool:cursor", true], ["tool:grok", false]]);
  assert.ok(g[5].items.every((i) => i.disabled && i.title));
  assert.equal(g[5].items[1].title, "Terms first.");
});

test("Open WebUI's address for a new chat with a model", () => {
  assert.equal(A.chatSrc("http://chat.bedrock-now.localhost/?x=1#y", "or/x:free"), "http://chat.bedrock-now.localhost/?models=or%2Fx%3Afree");
  assert.equal(A.chatSrc("http://chat.bedrock-now.localhost/", ""), "http://chat.bedrock-now.localhost/");
  assert.equal(A.terminalSrc, undefined, "the page never builds the terminal's words itself: the portal does, with a launch token");
});

test("the saved choice is read back checked", () => {
  assert.deepEqual(plain(A.parseSaved(JSON.stringify({ chat: "tool:codex", folder: "/workspace/app" }))), { chat: "tool:codex", folder: "/workspace/app" });
  for (const bad of [null, "{", "[]", JSON.stringify({ chat: "javascript:x", folder: "rel" }), JSON.stringify({ chat: "tool:../x", folder: "/a\nb" })]) {
    assert.deepEqual(plain(A.parseSaved(bad)), { chat: "owui", folder: "" }, String(bad));
  }
});
