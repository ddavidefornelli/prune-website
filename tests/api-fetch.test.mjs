import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedFetch } from "../src/cloud/api-fetch.ts";

const apiFetch = (input, init, timeoutMs) =>
  boundedFetch.request(input, init, timeoutMs);
import { HTTP_LIMITS } from "../src/shared/api-routes.ts";

const bytes = (value) => new TextEncoder().encode(value);

test("API requests omit credentials and referrers, and rebuild exact streamed bytes", async (t) => {
  let options;
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    options = init;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes('{"value":'));
          controller.enqueue(bytes('"✓"}'));
          controller.close();
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "999",
          "Content-Encoding": "gzip",
        },
      },
    );
  });
  const response = await apiFetch("https://example.test/api", {
    credentials: "include",
    redirect: "follow",
    method: "POST",
  });
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.equal(options.referrerPolicy, "no-referrer");
  assert.equal(options.method, "POST");
  assert.equal(response.headers.get("Content-Length"), null);
  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.deepEqual(await response.json(), { value: "✓" });
});

test("oversized responses fail without awaiting an untrusted cancellation hook", async (t) => {
  let canceled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(HTTP_LIMITS.responseBytes + 1));
          },
          cancel() {
            canceled = true;
            return new Promise(() => {});
          },
        }),
      ),
  );
  await assert.rejects(apiFetch("https://example.test/api"), { code: "size" });
  assert.equal(canceled, true);
});

test("request deadlines include stalled bodies, not only response headers", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            return new Promise(() => {});
          },
        }),
      ),
  );
  await assert.rejects(apiFetch("https://example.test/api", undefined, 10), {
    name: "AbortError",
  });
});

test("a Request object's abort signal is preserved when no init signal overrides it", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_input, { signal }) => {
    assert.equal(signal.aborted, true);
    throw signal.reason;
  });
  const request = new Request("https://example.test/api", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(apiFetch(request), { name: "AbortError" });
});

test("no-content responses retain their original status without manufacturing a body", async (t) => {
  const original = new Response(null, { status: 204 });
  t.mock.method(globalThis, "fetch", async () => original);
  assert.equal(await apiFetch("https://example.test/logout"), original);
});
