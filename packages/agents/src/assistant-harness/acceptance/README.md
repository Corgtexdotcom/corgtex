# Synthetic composed acceptance

These tests compose the actual `createAssistantHarness`, its authorization guard,
and `openAICompatibleModelGateway`. Only provider HTTP/streams, usage dependencies,
and application-owned ports are synthetic. Unexpected HTTP fails closed; no real
provider calls or credentials are used.

Run on Node 22.22:

```sh
npm run test:unit -- packages/agents/src/assistant-harness/acceptance
```

The retry cases exercise authorization after saved read provenance enters the
graph, across provider retries and awaited authorization. They distinguish a
harness invocation reservation from individual provider HTTP attempts. Stream
cases exercise guarded delivery, detachment, cancellation and transport cleanup.
Replay/publication cases use private canaries to distinguish the model context
from the exact explicitly selected publication payload, then exercise fresh
authority checks and canonical synthetic receipt inspection on replay.

Barriers control asynchronous boundaries; retry time advances with fake timers.
The production graph, gateway, checkpoint wrapper and authorization guard are
not mocked. The application authorization and reservation implementations are
deliberately synthetic ports, not production permission or budget integration.

**MemorySaver checkpoints and synthetic receipts are not proof of real PostgreSQL
durability**, transactional fencing, process-crash recovery, socket/database
atomicity, real provider billing, or production exactly-once publication. A new
runner here remains in the same process. These tests do not enable or register
the harness, a worker, a schema, or a production transport.
