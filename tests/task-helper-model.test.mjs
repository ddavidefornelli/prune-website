import assert from "node:assert/strict";
import { test } from "node:test";
import { HelperModel, HelperModelError } from "../server/helper/model.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const brief = { title: "Email Marco", kind: "draft", context: ["Buy milk"], picks: [{ question: "Tone?", answer: "" }], locale: { timeZone: "Europe/Rome", language: "it-IT" } };

function fixture(replies) {
  const requests = [];
  const model = new HelperModel({
    url: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "key",
    model: "deepseek/deepseek-v4.1-flash",
    extra: { provider: { ignore: ["deepseek"] } },
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const reply = replies.shift();
      if (reply instanceof Response) return reply;
      return Response.json({ choices: [{ finish_reason: reply.finish ?? "stop", message: { content: reply.content } }] });
    },
  });
  return { model, requests };
}

test("sorting sends the titles as JSON with the provider routing, and keeps only known ids and kinds", async () => {
  const f = fixture([{ content: '```json\n{"items":[{"id":"' + ID + '","kind":"draft"},{"id":"other","kind":"plan"}]}\n```' }]);
  const kinds = await f.model.classify([{ id: ID, title: "Email Marco" }, { id: "x", title: "Buy milk" }]);
  assert.deepEqual([...kinds], [[ID, "draft"], ["x", null]]);
  const [request] = f.requests;
  assert.equal(request.headers.Authorization, "Bearer key");
  assert.equal(request.body.model, "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(request.body.provider, { ignore: ["deepseek"] });
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(request.body.messages[0].role, "system");
  assert.match(request.body.messages[1].content, /"item":"Email Marco"/);
});

test("questions keep two non-empty options each, at most three", async () => {
  const f = fixture([{ content: JSON.stringify({ questions: [{ question: "Tone?", options: ["Warm", "Formal", "Funny"] }, { question: "Bad", options: ["One"] }, { question: "Length?", options: ["Short", "Long"] }, { question: "A?", options: ["a", "b"] }, { question: "B?", options: ["a", "b"] }] }) }]);
  assert.deepEqual(await f.model.choices(brief), [
    { question: "Tone?", options: ["Warm", "Formal"] },
    { question: "Length?", options: ["Short", "Long"] },
    { question: "A?", options: ["a", "b"] },
  ]);
  assert.match(f.requests[0].body.messages[1].content, /Task: Email Marco\nWhat to make: a text to write\nNow: .+\(Europe\/Rome\)\nBrowser language: it-IT\n\nThe person's choices:\n- Tone\? Either is fine\./);
});

test("an answer is plain text; a refine replays the first answer and the conversation", async () => {
  const f = fixture([{ content: "  Ciao Marco,\n- venerdì  " }, { content: "Ciao Marco." }]);
  assert.deepEqual(await f.model.answer(brief, null, []), { answer: "Ciao Marco,\n- venerdì", sources: [] });
  assert.equal(f.requests[0].body.response_format, undefined);
  await f.model.answer(brief, "Ciao Marco,\n- venerdì", [{ role: "user", text: "Shorter" }]);
  assert.deepEqual(f.requests[1].body.messages.slice(2).map(({ role, content }) => [role, content]), [
    ["assistant", "Ciao Marco,\n- venerdì"],
    ["user", "Shorter"],
  ]);
});

test("a filtered, empty or unreadable reply is a model error; an HTTP failure is not", async () => {
  await assert.rejects(fixture([{ content: "", finish: "content_filter" }]).model.answer(brief, null, []), (error) => error instanceof HelperModelError && error.message === "refused");
  await assert.rejects(fixture([{ content: "  " }]).model.answer(brief, null, []), (error) => error instanceof HelperModelError && error.message === "empty");
  await assert.rejects(fixture([{ content: "not json" }]).model.choices(brief), (error) => error instanceof HelperModelError && error.message === "unreadable");
  await assert.rejects(fixture([new Response("busy", { status: 503 })]).model.answer(brief, null, []), (error) => !(error instanceof HelperModelError) && /503/.test(error.message));
});
