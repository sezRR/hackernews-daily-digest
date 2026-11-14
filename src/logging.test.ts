import { assert, it } from "@effect/vitest";
import { Cause } from "effect";
import { formatLine, timestamp } from "./logging.js";

const options = (overrides: Partial<Parameters<typeof formatLine>[1]> = {}) =>
  ({
    message: ["Digest 2026-11-14: sent"],
    logLevel: "Info",
    cause: Cause.empty,
    fiber: undefined as never,
    date: new Date(2026, 10, 14, 7, 30, 2),
    ...overrides,
  }) as Parameters<typeof formatLine>[1];

it("timestamps carry the date, the local time and the UTC offset", () => {
  assert.match(timestamp(new Date(2026, 10, 14, 7, 30, 2)), /^2026-11-14 07:30:02 [+-]\d\d:\d\d$/);
});

it("writes one greppable line with level and job", () => {
  assert.match(
    formatLine("digest", options()),
    /^2026-11-14 07:30:02 [+-]\d\d:\d\d INFO  \[digest\] Digest 2026-11-14: sent$/,
  );
});

it("puts the cause of a failure under the line", () => {
  const line = formatLine(
    "replies",
    options({ logLevel: "Error", message: ["Reply failed"], cause: Cause.fail(new Error("smtp down")) }),
  );

  assert.match(line, /ERROR \[replies\] Reply failed\n/);
  assert.include(line, "smtp down");
});
