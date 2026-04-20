export type ObjectionValidationResult = {
  isValid: boolean;
  criteria: {
    degradation: { met: boolean; rationale: string };
    causality: { met: boolean; rationale: string };
    dataBased: { met: boolean; rationale: string };
    roleRelated: { met: boolean; rationale: string };
  };
};

export function validateObjectionCriteria(params: {
  objectionBodyMd: string;
  degradationClaim: string;
  causalityClaim: string;
  dataBasedClaim: string;
  isCatastrophicHarm: boolean;
  affectedRoleId: string | null;
  objectorRoleIds: string[];
}): ObjectionValidationResult {
  const degradation = {
    met: params.degradationClaim.trim().length > 0,
    rationale: params.degradationClaim.trim() || "No specific degradation to the organization's capacity was identified.",
  };

  const causality = {
    met: params.causalityClaim.trim().length > 0,
    rationale: params.causalityClaim.trim() || "The objection describes a pre-existing issue rather than a consequence caused by this proposal.",
  };

  const dataBased = {
    met: params.isCatastrophicHarm || params.dataBasedClaim.trim().length > 0,
    rationale: params.isCatastrophicHarm 
      ? "Waived: Anticipated harm is catastrophic or irreversible, so we cannot afford to wait for data." 
      : (params.dataBasedClaim.trim() || "Anticipation of future harm that is safe-to-try. We can gather data from trying it."),
  };

  const roleRelated = {
    met: params.affectedRoleId ? params.objectorRoleIds.includes(params.affectedRoleId) : false,
    rationale: (params.affectedRoleId && params.objectorRoleIds.includes(params.affectedRoleId))
      ? "The objection affects a role energized by the objector."
      : "The objector is attempting to process an objection on behalf of a role they do not hold.",
  };

  const isValid = degradation.met && causality.met && dataBased.met && roleRelated.met;

  return {
    isValid,
    criteria: {
      degradation,
      causality,
      dataBased,
      roleRelated,
    },
  };
}
