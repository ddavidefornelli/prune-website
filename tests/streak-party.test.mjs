import assert from "node:assert/strict";
import test from "node:test";
import { BITS, DANCES, isMilestone, milestoneHeadline, pickParty } from "../src/planner/streak-party.ts";

const seeded = (seed) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

test("milestones get their own words; ordinary days get a random cheer", () => {
  assert.equal(pickParty(1).headline, "Day one. Let's go!");
  assert.equal(pickParty(7).headline, "A whole week!");
  assert.equal(pickParty(100).headline, "Triple digits!");
  assert.equal(milestoneHeadline(400), "400 days. Legend.");
  assert.equal(milestoneHeadline(12), null);
  assert.equal(isMilestone(1), false);
  assert.equal(isMilestone(30), true);
});

test("the party varies from day to day, within bounds", () => {
  const dances = new Set();
  const headlines = new Set();
  for (let seed = 1; seed < 60; seed++) {
    const party = pickParty(12, seeded(seed));
    dances.add(party.dance);
    headlines.add(party.headline);
    assert.equal(party.confetti.length, 36);
    for (const piece of party.confetti) {
      assert.ok(BITS.includes(piece.bit));
      assert.ok(piece.x >= -0.5 && piece.x <= 0.5);
      assert.ok(piece.delay >= 0 && piece.delay <= 0.5);
    }
  }
  assert.equal(dances.size, DANCES.length);
  assert.ok(headlines.size >= 5);
  assert.equal(pickParty(30, seeded(3)).confetti.length, 56);
  // Even a random source that returns 1 stays in range.
  assert.ok(DANCES.includes(pickParty(5, () => 0.9999999999).dance));
});
