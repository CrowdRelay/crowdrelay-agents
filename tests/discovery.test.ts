import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { _streamJsonArray, _parseFreeModel, _parseZenFreeModel } from "../src/agent/discovery.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a Response whose body streams the given string in fixed-size chunks. */
function chunkedResponse(json: string, chunkSize: number = 64): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < json.length; i += chunkSize) {
        controller.enqueue(new TextEncoder().encode(json.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

/** Collects all elements from the async generator into an array. */
async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// Streaming JSON array extractor
// ---------------------------------------------------------------------------

test("streamJsonArray: extracts objects from a simple array", async () => {
  const res = chunkedResponse('{"data":[{"id":"a"},{"id":"b"},{"id":"c"}]}');
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 3);
  assert.deepEqual(elems.map(JSON.parse), [{ id: "a" }, { id: "b" }, { id: "c" }]);
});

test("streamJsonArray: handles empty array", async () => {
  const res = chunkedResponse('{"data":[]}');
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 0);
});

test("streamJsonArray: handles braces inside string values", async () => {
  // Model descriptions often contain { and } characters.
  const res = chunkedResponse(
    '{"data":[{"id":"x","desc":"function() { return { a: 1 }; }"},{"id":"y"}]}',
  );
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 2);
  assert.equal(JSON.parse(elems[0]).id, "x");
  assert.equal(JSON.parse(elems[1]).id, "y");
});

test("streamJsonArray: handles escaped quotes inside strings", async () => {
  const res = chunkedResponse(
    '{"data":[{"id":"x","desc":"he said \\"hello\\""},{"id":"y"}]}',
  );
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 2);
  assert.equal(JSON.parse(elems[0]).desc, 'he said "hello"');
});

test("streamJsonArray: handles backslash escapes", async () => {
  // \\\" inside a JSON string is a literal backslash + quote
  const res = chunkedResponse(
    '{"data":[{"id":"x","path":"C:\\\\Users\\\\test"},{"id":"y"}]}',
  );
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 2);
  assert.equal(JSON.parse(elems[0]).path, "C:\\Users\\test");
});

test("streamJsonArray: works with very small chunk size (1 byte)", async () => {
  // Forces every character to be its own chunk — tests buffer management.
  const json = '{"data":[{"id":"a","name":"model a"},{"id":"b","name":"model b"}]}';
  const res = chunkedResponse(json, 1);
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 2);
  assert.equal(JSON.parse(elems[0]).id, "a");
  assert.equal(JSON.parse(elems[1]).id, "b");
});

test("streamJsonArray: works with large chunk size (entire response at once)", async () => {
  const json = '{"data":[{"id":"a"},{"id":"b"},{"id":"c"}]}';
  const res = chunkedResponse(json, 10000);
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 3);
});

test("streamJsonArray: handles nested objects", async () => {
  const res = chunkedResponse(
    '{"data":[{"id":"x","pricing":{"prompt":"0","completion":"0"},"meta":{"nested":{"deep":true}}},{"id":"y"}]}',
  );
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 2);
  assert.equal(JSON.parse(elems[0]).pricing.prompt, "0");
  assert.equal(JSON.parse(elems[0]).meta.nested.deep, true);
});

test("streamJsonArray: handles array key spanning chunk boundary", async () => {
  // The key "data":[ is split across two chunks
  const json = '{"data":[{"id":"a"}]}';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"dat'));
      controller.enqueue(new TextEncoder().encode('a":[{"id":"a"}]}'));
      controller.close();
    },
  });
  const res = new Response(stream);
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 1);
  assert.equal(JSON.parse(elems[0]).id, "a");
});

test("streamJsonArray: handles object spanning many chunks", async () => {
  // One object split across 5 chunks
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('{"data":[{'));
      controller.enqueue(enc.encode('"id":"x",'));
      controller.enqueue(enc.encode('"name":"big model"'));
      controller.enqueue(enc.encode(',"context_length":'));
      controller.enqueue(enc.encode('128000}]}'));

      controller.close();
    },
  });
  const res = new Response(stream);
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 1);
  const parsed = JSON.parse(elems[0]);
  assert.equal(parsed.id, "x");
  assert.equal(parsed.context_length, 128000);
});

test("streamJsonArray: ignores other top-level keys before data", async () => {
  const res = chunkedResponse(
    '{"meta":{"count":3},"data":[{"id":"a"},{"id":"b"}],"other":[1,2,3]}',
  );
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 2);
  assert.equal(JSON.parse(elems[0]).id, "a");
});

test("streamJsonArray: handles custom array key", async () => {
  const res = chunkedResponse('{"models":[{"id":"a"}]}');
  const elems = await collect(_streamJsonArray(res, '"models"'));
  assert.equal(elems.length, 1);
  assert.equal(JSON.parse(elems[0]).id, "a");
});

test("streamJsonArray: handles objects with arrays inside", async () => {
  const res = chunkedResponse(
    '{"data":[{"id":"x","tags":["a","b","c"],"supported_parameters":[1,2]},{"id":"y"}]}',
  );
  const elems = await collect(_streamJsonArray(res));
  assert.equal(elems.length, 2);
  assert.deepEqual(JSON.parse(elems[0]).tags, ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// Free model filter
// ---------------------------------------------------------------------------

test("parseFreeModel: returns model when both prompt and completion are '0'", () => {
  const m = _parseFreeModel('{"id":"x","name":"X","context_length":128000,"pricing":{"prompt":"0","completion":"0"}}');
  assert.ok(m);
  assert.equal(m!.id, "x");
  assert.equal(m!.pricing.prompt, "0");
});

test("parseFreeModel: returns null when prompt is non-zero", () => {
  const m = _parseFreeModel('{"id":"x","pricing":{"prompt":"0.000001","completion":"0"}}');
  assert.equal(m, null);
});

test("parseFreeModel: returns null when completion is non-zero", () => {
  const m = _parseFreeModel('{"id":"x","pricing":{"prompt":"0","completion":"0.000002"}}');
  assert.equal(m, null);
});

test("parseFreeModel: returns null for invalid JSON", () => {
  assert.equal(_parseFreeModel('not json'), null);
  assert.equal(_parseFreeModel('{'), null);
  assert.equal(_parseFreeModel(''), null);
});

test("parseFreeModel: returns null when id is missing", () => {
  const m = _parseFreeModel('{"name":"x","pricing":{"prompt":"0","completion":"0"}}');
  assert.equal(m, null);
});

test("parseFreeModel: returns null when pricing is missing", () => {
  const m = _parseFreeModel('{"id":"x","name":"X"}');
  assert.equal(m, null);
});

// ---------------------------------------------------------------------------
// Zen free model filter
// ---------------------------------------------------------------------------

test("parseZenFreeModel: returns model with -free suffix", () => {
  const m = _parseZenFreeModel('{"id":"qwen/qwen3-free","name":"Qwen Free","context_length":32768,"pricing":{"prompt":"0","completion":"0"}}');
  assert.ok(m);
  assert.equal(m!.id, "qwen/qwen3-free");
});

test("parseZenFreeModel: returns model with :free in id", () => {
  const m = _parseZenFreeModel('{"id":"meta/llama:free","name":"Llama Free","context_length":8192}');
  assert.ok(m);
  assert.equal(m!.id, "meta/llama:free");
});

test("parseZenFreeModel: returns null for non-free model", () => {
  const m = _parseZenFreeModel('{"id":"gpt-4o","name":"GPT-4o"}');
  assert.equal(m, null);
});

test("parseZenFreeModel: returns null for invalid JSON", () => {
  assert.equal(_parseZenFreeModel('broken'), null);
});
