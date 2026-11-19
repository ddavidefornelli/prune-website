import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, LimitedBody } from "../server/http.ts";

const readLimited = LimitedBody.read;

const stream = (...chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });

test("bounded server reads preserve UTF-8 split between chunks and release the reader", async () => {
  const body = stream([0xe2], [0x9c, 0x93]);
  assert.equal(await readLimited(body, 3), "✓");
  assert.equal(body.locked, false);
});

test("bounded server reads reject malformed UTF-8 and missing bodies", async () => {
  await assert.rejects(readLimited(stream([0xff]), 3), TypeError);
  await assert.rejects(
    readLimited(null, 3),
    (error) => error instanceof ApiError && error.code === "invalid_json",
  );
});

test("oversized server bodies cannot hang the API through stream cancellation", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  await assert.rejects(readLimited(body, 3), {
    status: 413,
    code: "payload_too_large",
  });
  assert.equal(body.locked, false);
});

test("stalled server bodies time out even if cancellation rejects", async () => {
  const body = new ReadableStream({
    cancel() {
      return Promise.reject(new Error("broken cancellation"));
    },
  });
  await assert.rejects(readLimited(body, 3, 10), {
    status: 408,
    code: "read_timeout",
  });
  assert.equal(body.locked, false);
});
