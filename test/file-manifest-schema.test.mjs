import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFileManifest } from "../src/schemas/file-manifest-schema.mjs";

test("accepts a valid manifest", () => {
  const result = validateFileManifest({
    slug: "spring-sale",
    summary: "Adds a landing page for the spring security sale campaign.",
    designNotes: "Use the existing card component style for pain points.",
    filesToCreate: [{ path: "app/campaigns/spring-sale/page.tsx", purpose: "Main landing page route" }],
  });
  assert.equal(result.ok, true);
});

test("rejects an empty filesToCreate array", () => {
  const result = validateFileManifest({
    slug: "spring-sale",
    summary: "x".repeat(20),
    designNotes: "y".repeat(20),
    filesToCreate: [],
  });
  assert.equal(result.ok, false);
});

test("rejects more than 15 files (keeps the change scope tight)", () => {
  const filesToCreate = Array.from({ length: 16 }, (_, i) => ({
    path: `app/campaigns/spring-sale/file-${i}.tsx`,
    purpose: "test file",
  }));
  const result = validateFileManifest({
    slug: "spring-sale",
    summary: "x".repeat(20),
    designNotes: "y".repeat(20),
    filesToCreate,
  });
  assert.equal(result.ok, false);
});
