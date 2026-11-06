# Changelog

## Unreleased

### Action event contracts

- Canonical `action.created` and `action.updated` producers add `eventVersion: 1`
  to the event payload. Outbound webhook delivery includes this additive field at
  `payload.eventVersion` inside the existing envelope. Existing payload fields,
  event names, aggregate identifiers, and webhook envelope fields are retained.
  Receivers with strict payload schemas should allow this field before upgrading.
- Unversioned persisted action events retain explicit legacy handling. Other event
  families, including `action.published` and `action.assigned`, are not versioned by
  this pilot. Replays retain the persisted payload's original version interpretation.
- Generic inbound `action.created` events continue to schedule workspace inbox
  triage, including payloads without an action ID or with an unsupported version.
  Invalid or unsupported action payloads do not schedule action knowledge/context
  sync. Dispatch emits an `action_event_sync_rejected` warning with event identifiers
  and decoder status, without logging payload content. Triage deduplication and raw
  outbound webhook delivery remain unchanged.
