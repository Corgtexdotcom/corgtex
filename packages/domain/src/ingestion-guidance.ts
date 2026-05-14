type GuidanceCorrection = {
  from: string;
  to: string;
  domainTo?: string;
  nameTo?: string;
};

function cleanCorrectionTerm(value: string) {
  return value
    .replace(/^\s*(?:["'“”]|the\s+term\s+|term\s+)/i, "")
    .replace(/(?:["'“”]|[.!?;,:\s])+$/g, "")
    .trim();
}

function cleanCorrectionReplacement(value: string) {
  return cleanCorrectionTerm(value.replace(/^\s*(?:it(?:'|’)?s|it\s+is|should\s+be|use)\s+/i, ""));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyDomain(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}$/i.test(value);
}

function isLikelyEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value);
}

function isReadableNameTarget(value: string) {
  return !isLikelyDomain(value) && !isLikelyEmailAddress(value);
}

function parseCorrectionTargets(value: string) {
  const withoutQualifier = value.replace(/\s+(?:depends|depending)\b.*$/i, "");
  const targets = withoutQualifier
    .split(/\s+or\s+/i)
    .map(cleanCorrectionReplacement)
    .filter(Boolean);
  const to = targets[0] ?? "";
  const domainTo = targets.find(isLikelyDomain);
  const nameTo = targets.find((target) => target !== domainTo && isReadableNameTarget(target));
  return {
    to,
    domainTo,
    nameTo,
  };
}

export function extractGuidanceTermCorrections(guidanceMd: string | null | undefined): GuidanceCorrection[] {
  if (!guidanceMd) return [];

  const corrections: GuidanceCorrection[] = [];
  const seen = new Set<string>();
  const correctionPattern = /(?:^|[\n.!?;]\s*)(?:additional guidance:\s*)?(?:it(?:'|’)?s|it\s+is|this\s+is|that\s+is)?\s*not\s+([^,\n:;–—-]{1,80}?)\s*(?:-|–|—|,|:|;)\s*([^\n!?;]{1,160})/gi;
  for (const match of guidanceMd.matchAll(correctionPattern)) {
    const from = cleanCorrectionTerm(match[1] ?? "");
    const { to, domainTo, nameTo } = parseCorrectionTargets(match[2] ?? "");
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    const key = `${from.toLowerCase()}=>${to.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    corrections.push({ from, to, domainTo, nameTo });
  }
  return corrections;
}

function replaceStandaloneDomainTerm(text: string, from: string, to: string) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9.@-])(${escapeRegExp(from)})(?=$|[^A-Za-z0-9.-]|\\.(?![A-Za-z0-9-]))`, "gi");
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${to}`);
}

function replaceStandaloneTerm(text: string, from: string, to: string) {
  if (isLikelyDomain(from)) return replaceStandaloneDomainTerm(text, from, to);
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

function replaceDomainContext(text: string, from: string, to: string) {
  const sourceDomainPattern = isLikelyDomain(from)
    ? escapeRegExp(from)
    : `${escapeRegExp(from)}(?:\\.[A-Za-z0-9-]+)+`;
  const pattern = new RegExp(`(^|[^A-Za-z0-9.-])(${sourceDomainPattern})(?=$|[^A-Za-z0-9.-]|\\.(?![A-Za-z0-9-]))`, "gi");
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${to.toLowerCase()}`);
}

export function applyGuidanceTermCorrections(text: string, guidanceMd: string | null | undefined) {
  return extractGuidanceTermCorrections(guidanceMd).reduce((current, correction) => {
    const domainCorrected = correction.domainTo && isLikelyDomain(correction.domainTo)
      ? replaceDomainContext(current, correction.from, correction.domainTo)
      : current;
    return replaceStandaloneTerm(domainCorrected, correction.from, correction.nameTo ?? correction.to);
  }, text);
}
