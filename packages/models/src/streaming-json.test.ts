import { describe, expect, it } from "vitest";
import { IncrementalJsonStringDecoder } from "./streaming-json";
function decode(fragments: string[], field = "answer") {
  const decoder = new IncrementalJsonStringDecoder(field);
  let output = "";
  const states = fragments.map((fragment) => {
    const result = decoder.push(fragment);
    output += result.delta;
    return result.state;
  });
  return { output, states, final: decoder.finish() };
}
describe("IncrementalJsonStringDecoder", () => {
  it("streams only new decoded characters across arbitrary boundaries", () => {
    const source = '{"meta":{"nested":"answer"},"answer":"Hello \\"route\\"!"}';
    const result = decode([...source]);
    expect(result.output).toBe('Hello "route"!');
    expect(result.final).toEqual({ delta: "", state: "complete" });
  });
  it("handles unrelated properties before and after the target", () => {
    const result = decode([
      '{"count":2,"items":[{"answer":"decoy"}],',
      '"answer":"kept",',
      '"later":true}',
    ]);
    expect(result.output).toBe("kept");
    expect(result.final.state).toBe("complete");
  });
  it("waits for complete escapes and surrogate pairs", () => {
    const decoder = new IncrementalJsonStringDecoder("answer");
    expect(decoder.push('{"answer":"A\\')).toEqual({ delta: "A", state: "incomplete" });
    expect(decoder.push('n\\uD834')).toEqual({ delta: "\n", state: "incomplete" });
    expect(decoder.push('\\uDD1E')).toEqual({ delta: "𝄞", state: "incomplete" });
    expect(decoder.push(' café"}')).toEqual({ delta: " café", state: "complete" });
    expect(decoder.finish().state).toBe("complete");
  });
  it.each([
    ['{"answer":"bad\\x"}', "malformed"],
    ['{"answer":42}', "malformed"],
    ['{"other":"value"}', "malformed"],
    ['{"answer":"truncated', "incomplete"],
    ['{"before":[1,2}', "malformed"],
  ])("reports %s as %s", (source, state) => {
    const decoder = new IncrementalJsonStringDecoder("answer");
    decoder.push(source);
    expect(decoder.finish().state).toBe(state);
  });
  it("rejects a malformed suffix only at terminal validation", () => {
    const decoder = new IncrementalJsonStringDecoder("answer");
    expect(decoder.push('{"answer":"visible"')).toEqual({ delta: "visible", state: "complete" });
    expect(decoder.push(',"broken":}').delta).toBe("");
    expect(decoder.finish().state).toBe("malformed");
  });
});
