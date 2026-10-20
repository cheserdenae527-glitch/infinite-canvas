import { expect, test } from "bun:test";

import { videoTrimArgs } from "../src/lib/canvas/video-trim-range";

test("trims a fractional interval by decoding to its start and encoding its duration", () => {
    const args = videoTrimArgs({ start: 1.25, end: 3.75 });
    expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("1.25");
    expect(args[args.indexOf("-t") + 1]).toBe("2.5");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("0:a:0?");
    expect(args).not.toContain("copy");
});

test("accepts the beginning of the source", () => {
    const args = videoTrimArgs({ start: 0, end: 1 });
    expect(args[args.indexOf("-ss") + 1]).toBe("0");
});

for (const range of [
    { start: -1, end: 2 },
    { start: 1, end: 1 },
    { start: 2, end: 1 },
    { start: NaN, end: 2 },
    { start: 0, end: Infinity },
    { start: 0, end: NaN },
]) {
    test(`rejects an invalid trim interval ${JSON.stringify(range)}`, () => {
        expect(() => videoTrimArgs(range)).toThrow();
    });
}
