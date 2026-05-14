type GuidanceCorrection = {
  from: string;
  to: string;
};

function cleanCorrectionTerm(value: string) {
  return value
    .replace(/^\s*(?:["'“”]|the\s+term\s+|term\s+)/i, "")
    .replace(/(?:["'“”]|[.!?;,:\s])+$/g, "")
    .trim();
}

function cleanCorrectionReplacement(value: string) {
  const withoutQualifier = value
    .replace(/^\s*(?:it(?:'|’)?s|it\s+is|should\s+be|use)\s+/i, "")
    .split(/\s+(?:or|depends|depending)\b/i)[0] ?? "";
  return cleanCorrectionTerm(withoutQualifier);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractGuidanceTermCorrections(guidanceMd: string | null | undefined): GuidanceCorrection[] {
  if (!guidanceMd) return [];

  const corrections: GuidanceCorrection[] = [];
  const seen = new Set<string>();
  const correctionPattern = /(?:^|[\n.!?;]\s*)(?:additional guidance:\s*)?(?:it(?:'|’)?s|it\s+is|this\s+is|that\s+is)?\s*not\s+([^,\n:;–—-]{1,80}?)\s*(?:-|–|—|,|:|;)\s*([^\n!?;]{1,160})/gi;
  for (const match of guidanceMd.matchAll(correctionPattern)) {
    const from = cleanCorrectionTerm(match[1] ?? "");
    const to = cleanCorrectionReplacement(match[2] ?? "");
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    const key = `${from.toLowerCase()}=>${to.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    corrections.push({ from, to });
  }
  return corrections;
}

function replaceStandaloneTerm(text: string, from: string, to: string) {
  const pattern = new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi");
  return text.replace(pattern, (match, offset, fullText) => {
    const previous = offset > 0 ? fullText[offset - 1] : "";
    const next = fullText[offset + match.length] ?? "";
    const afterNext = fullText[offset + match.length + 1] ?? "";
    if (previous === "@" || previous === "/" || previous === "." || previous === "-") return match;
    if (next === "@" || next === "/" || next === "-") return match;
    if (next === "." && /[A-Za-z0-9]/.test(afterNext)) return match;
    return to;
  });
}

export function applyGuidanceTermCorrections(text: string, guidanceMd: string | null | undefined) {
  return extractGuidanceTermCorrections(guidanceMd).reduce((current, correction) => (
    replaceStandaloneTerm(current, correction.from, correction.to)
  ), text);
}
