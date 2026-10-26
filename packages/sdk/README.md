# @appneurox/techlyup-service-sdk

Client for Techlyup Service. Works in Node 18+, browsers, React Native and edge runtimes.

```ts
import { createTechlyupServiceClient } from '@appneurox/techlyup-service-sdk';

// Standalone microservice
const direct = createTechlyupServiceClient({ token, tenantId });

// Same module through a brand API (modular monolith)
const viaBrand = createTechlyupServiceClient({ monolithUrl: 'https://<brand>-api.appneurox.com', token, tenantId });

await viaBrand.metadata();
await viaBrand.execute('<operation>', { /* payload */ });
```

Errors throw `ApiError` (`status`, `code`, `requestId`). Brand SDKs (`@appneurox/<brand>-sdk`)
bundle this client with the other services that brand uses.
