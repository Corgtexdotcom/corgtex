import { describe, expect, it } from "vitest";
import { IncrementalJsonStringDecoder } from "./streaming-json";
function decode(fragments: string[], field = "answer") {
  const decoder = new IncrementalJsonStringDecoder(field); let output = "";
  const states = fragments.map((fragment) => { const result = decoder.push(fragment); output += result.delta; return result.state; });
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
    const result = decode(['{"count":2,"items":[{"answer":"decoy"}],', '"answer":"kept",', '"later":true}']);
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
    const raw = new IncrementalJsonStringDecoder("answer"); const pair = "𝄞"; expect(raw.push(`{"answer":"${pair[0]}`)).toEqual({ delta: "", state: "incomplete" }); expect(raw.push(`${pair[1]}!"}`)).toEqual({ delta: "𝄞!", state: "complete" }); expect(raw.finish().state).toBe("complete");
  });
  it.each([['{"answer":"bad\\x"}', "malformed"], ['{"answer":42}', "malformed"], ['{"other":"value"}', "malformed"], ['{"answer":"truncated', "incomplete"], ['{"before":[1,2}', "malformed"], ['{"answer":"\ud834x"}', "malformed"], ['{"answer":"\udd1e"}', "malformed"]])("reports %s as %s", (source, state) => {
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
  it("classifies every target-complete proper prefix of valid documents", () => {
    const documents = ['{"answer":"ok"}', '{"answer":"ok","later":{"array":[true,false,null,-12.3e+4,"tail"]}}', '{"before":[0],"answer":"ok","after":[{"k":"v"},2]}   '];
    for (const document of documents) { const targetEnd = document.indexOf('"ok"') + 4; for (let end = targetEnd; end < document.length; end += 1) { const prefix = document.slice(0, end); let complete = true; try { JSON.parse(prefix); } catch { complete = false; } expect(decode([prefix]).final.state, prefix).toBe(complete ? "complete" : "incomplete"); } }
  });
  it.each(['{"answer":"ok"]', '{"answer":"ok"}garbage', '{"answer":"ok","later":truth}', '{"answer":"ok","later":01}', '{"answer":"ok","later":[1,]}', '{"answer":"ok","later":{"x":}}', '{"answer":"ok","later":"bad\\x"}'])("classifies impossible terminal suffix %s as malformed", (source) => { expect(decode([source]).final.state).toBe("malformed"); });
  it.each(['{"answer":"ok"}', '{"later":[true,false,null,-12.3e+4],"answer":"ok"}', '{"answer":"ok","later":{"x":"y"}}   '])("classifies complete document %s as complete", (source) => { expect(decode([source]).final.state).toBe("complete"); });
  it("processes a long one-character stream without rescanning prior input", () => {
    const source = `{"padding":"${"x".repeat(20_000)}","answer":"done"}`;
    const decoder = new IncrementalJsonStringDecoder("answer");
    let output = "";
    for (const character of source) output += decoder.push(character).delta;
    expect({ output, final: decoder.finish().state }).toEqual({ output: "done", final: "complete" });
    expect(decoder.processedCharacters).toBe(source.length);
  });
});
