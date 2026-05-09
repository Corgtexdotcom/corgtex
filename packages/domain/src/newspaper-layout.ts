export type NewspaperSurface = "dashboard" | "email";
export type NewspaperEmptyPolicy = "omit" | "show";
export type NewspaperLayoutVariant = "empty" | "sparse" | "balanced" | "meeting-heavy";
export type NewspaperSectionPlacement = "lead" | "wide" | "standard";

export type NewspaperSectionInput<SectionId extends string = string> = {
  id: SectionId;
  priority: number;
  itemCount: number;
  estimatedTextLength?: number;
  emptyPolicy?: NewspaperEmptyPolicy;
  surface?: NewspaperSurface;
};

export type NewspaperSectionLayout<SectionId extends string = string> = NewspaperSectionInput<SectionId> & {
  placement: NewspaperSectionPlacement;
  itemCap: number;
  excerptMaxLength: number;
};

export type NewspaperLayoutResult<SectionId extends string = string> = {
  variant: NewspaperLayoutVariant;
  visibleSections: NewspaperSectionLayout<SectionId>[];
  sectionCaps: Record<string, {
    itemCap: number;
    excerptMaxLength: number;
    placement: NewspaperSectionPlacement;
  }>;
};

const MEETING_HEAVY_THRESHOLD = 3;

const SECTION_ITEM_CAPS: Record<string, Partial<Record<NewspaperLayoutVariant, number>>> = {
  featuredKnowledge: { sparse: 4, balanced: 4, "meeting-heavy": 3 },
  meetings: { sparse: 3, balanced: 2, "meeting-heavy": 5 },
  todos: { sparse: 6, balanced: 6, "meeting-heavy": 4 },
  tensions: { sparse: 4, balanced: 4, "meeting-heavy": 4 },
  activity: { sparse: 5, balanced: 5, "meeting-heavy": 4 },
  strategic: { sparse: 4, balanced: 4, "meeting-heavy": 4 },
  published: { sparse: 10, balanced: 10, "meeting-heavy": 8 },
  wiki: { sparse: 8, balanced: 8, "meeting-heavy": 6 },
  keyDecisions: { sparse: 5, balanced: 4, "meeting-heavy": 4 },
  actionItems: { sparse: 6, balanced: 6, "meeting-heavy": 5 },
  builtWork: { sparse: 5, balanced: 5, "meeting-heavy": 5 },
  conversationHighlights: { sparse: 5, balanced: 4, "meeting-heavy": 4 },
  teamPulse: { sparse: 3, balanced: 3, "meeting-heavy": 3 },
  emergingTensions: { sparse: 4, balanced: 4, "meeting-heavy": 4 },
};

const SECTION_EXCERPT_CAPS: Record<string, Partial<Record<NewspaperLayoutVariant, number>>> = {
  featuredKnowledge: { sparse: 260, balanced: 220, "meeting-heavy": 190 },
  meetings: { sparse: 160, balanced: 120, "meeting-heavy": 180 },
  todos: { sparse: 120, balanced: 90, "meeting-heavy": 80 },
  tensions: { sparse: 140, balanced: 120, "meeting-heavy": 110 },
  activity: { sparse: 120, balanced: 100, "meeting-heavy": 90 },
};

function normalizeCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isMeetingSection(id: string) {
  return id === "meetings" || id === "yourMeetings";
}

function itemCapFor(section: NewspaperSectionInput, variant: NewspaperLayoutVariant, visibleSectionCount: number) {
  const count = normalizeCount(section.itemCount);
  const configured = SECTION_ITEM_CAPS[section.id]?.[variant];
  if (typeof configured === "number") return Math.min(count, configured);
  if (section.surface === "email") return Math.min(count, variant === "sparse" ? 6 : 4);
  return Math.min(count, visibleSectionCount <= 2 ? 5 : 4);
}

function excerptCapFor(section: NewspaperSectionInput, variant: NewspaperLayoutVariant) {
  const configured = SECTION_EXCERPT_CAPS[section.id]?.[variant];
  if (typeof configured === "number") return configured;
  if (section.surface === "email") return variant === "sparse" ? 240 : 180;
  return variant === "sparse" ? 180 : 140;
}

function placementFor(section: NewspaperSectionInput, variant: NewspaperLayoutVariant, index: number): NewspaperSectionPlacement {
  if (variant === "meeting-heavy" && isMeetingSection(section.id)) return "wide";
  if (variant === "sparse" && index === 0 && normalizeCount(section.itemCount) > 1) return "lead";
  return "standard";
}

export function computeNewspaperLayout<SectionId extends string>(
  sections: Array<NewspaperSectionInput<SectionId>>
): NewspaperLayoutResult<SectionId> {
  const visibleInputs = sections.filter((section) => {
    const emptyPolicy = section.emptyPolicy ?? "omit";
    return normalizeCount(section.itemCount) > 0 || emptyPolicy === "show";
  });

  if (visibleInputs.length === 0) {
    return {
      variant: "empty",
      visibleSections: [],
      sectionCaps: {},
    };
  }

  const meetingSection = visibleInputs.find((section) => isMeetingSection(section.id));
  const meetingHeavy = normalizeCount(meetingSection?.itemCount ?? 0) >= MEETING_HEAVY_THRESHOLD;
  const variant: NewspaperLayoutVariant = meetingHeavy
    ? "meeting-heavy"
    : visibleInputs.length <= 2
      ? "sparse"
      : "balanced";

  const visibleSections = visibleInputs.map((section, index) => {
    const placement = placementFor(section, variant, index);
    return {
      ...section,
      itemCount: normalizeCount(section.itemCount),
      estimatedTextLength: normalizeCount(section.estimatedTextLength ?? 0),
      emptyPolicy: section.emptyPolicy ?? "omit",
      placement,
      itemCap: itemCapFor(section, variant, visibleInputs.length),
      excerptMaxLength: excerptCapFor(section, variant),
    };
  });

  return {
    variant,
    visibleSections,
    sectionCaps: Object.fromEntries(visibleSections.map((section) => [
      section.id,
      {
        itemCap: section.itemCap,
        excerptMaxLength: section.excerptMaxLength,
        placement: section.placement,
      },
    ])),
  };
}
