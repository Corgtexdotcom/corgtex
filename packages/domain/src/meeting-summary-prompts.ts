// Shared prompt text for the meeting-summary pipeline.
//
// These constants are the single source of truth for the block-extraction and
// summary model calls. They are consumed by the meeting-summary agent
// (packages/agents/src/agents/meeting-summary.ts) and by the A/B harness
// (scripts/meeting-summary-ab.ts) so the two cannot drift.

export const MEETING_BLOCK_EXTRACTION_INSTRUCTION = [
  "Identify the meeting's actual discussion blocks from transcript evidence.",
  "Do not force a fixed template. Use natural blocks from the conversation, including custom/ad-hoc topics.",
  "A block can be a check-in, update, tension, proposal discussion, decision, planning segment, or custom topic.",
  "Prefer fine-grained blocks over coarse ones. When a single person's update covers several distinct subjects (for example a personal note, a sourcing channel, and a financing route), split each distinct subject into its own block instead of merging them into one generic 'update'. A substantive topic that got a few minutes of discussion deserves its own block.",
  "Each block title should name the specific subject (for example 'Bank partnership and SBA financing', not 'Daniel's update'). Capture concrete specifics in the block summary — figures, named entities, instruments, and mechanisms (for example SBA 7(a) vs 504, dollar ranges, named banks or businesses) — rather than collapsing them into a single clause.",
  "Tie proposal discussions and decisions to supplied existing proposal, tension, or action records only when the transcript and context support it.",
  "Personal check-ins can be blocks, but they are not governance records unless explicit work follows.",
  "Correct meeting transcript drift where Cortex means Corgtex. Use Corgtex in block titles, block summaries, and source quotes.",
  "Return ordered blocks only. Do not invent transcript content.",
].join(" ");

export const MEETING_BLOCK_SCHEMA_HINT = `{
          "version": 1,
          "blocks": [
            {
              "sequence": "number",
              "title": "string",
              "kind": "check_in | update | tension | proposal_discussion | decision | planning | custom",
              "summaryMd": "string",
              "sourceQuote": "string",
              "relatedRecords": [
                { "entityType": "Action | Tension | Proposal", "entityId": "string", "title": "string" }
              ]
            }
          ]
        }`;

export const MEETING_SUMMARY_SYSTEM_PROMPT = [
  "Summarize this meeting for an operator dashboard.",
  "Return clean Markdown only, with no preamble or closing disclaimer.",
  "Write a fuller narrative summary organized around the supplied dynamic meeting blocks, with roughly twice the useful context of a terse recap and no repetition.",
  "Use the block titles as the main story spine. Preserve the meeting flow instead of forcing a fixed agenda template.",
  "For each block, explain what happened, why it mattered, the outcome or open question, and how it connects to decisions, proposals, tensions, actions, or follow-ups when evidence supports it.",
  "Preserve nuance and specifics. Keep figures, named people, named entities, instruments, and mechanisms that were discussed (for example dollar ranges, SBA 7(a) vs 504, named banks or target businesses) rather than flattening a rich discussion into a single clause. A reader should be able to revisit the summary later and recover what was actually said.",
  "End each block with a single bold takeaway line on its own (for example '**Takeaway:** ...') that states the decision, outcome, action, or open question for that block. Always include a takeaway when an owner committed to something or a next step was named.",
  "Explicitly tie decisions to the proposal, tension, or topic they belong to. If no clear decision was made, say what remained open.",
  "Do not leave owner-backed commitments only in the summary. Make action-oriented language explicit enough for downstream extraction to create separate action items.",
  "Use bullets for scannability. Include owners and dates only when the transcript supports them.",
  "Use user-provided ingestion guidance to decide what to emphasize or preserve, but do not invent facts unsupported by the transcript.",
  "Treat ingestion guidance as trusted operator context for spelling, name, and terminology corrections. If guidance corrects transcript wording, use the corrected wording in the summary and do not preserve conflicting text from currentSummary.",
  "Never echo the ingestion guidance text back into the summary. The guidance is an instruction for you, not content to display. Output only the resulting summary, never the request or instructions that produced it.",
  "Correct meeting transcript drift where Cortex means Corgtex. Use Corgtex in the human-facing summary.",
  "The supplied Corgtex context (open actions, open tensions, open proposals, recent deliberation, previous meetings, knowledge) is background for continuity only. Never output a section or list that enumerates these pre-existing records. Do not add headings such as 'Open Actions', 'Open Tensions', or 'Recent Deliberation'. Reference a prior record by title only inline, and only when this meeting actually discussed or changed it.",
  "When contextual intelligence is enabled, use the supplied Corgtex context to explain continuity from previous recurring meetings and to refer to active proposals, tensions, actions, deliberation, and relevant knowledge by title. Do not claim those records changed unless the transcript supports it.",
].join(" ");
