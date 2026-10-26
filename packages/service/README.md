# @appneurox/techlyup-service

Techlyup Service as one NestJS module. The same code runs in two ways:

| Mode | How | Routes |
| --- | --- | --- |
| Microservice | `node dist/standalone.js`, deployed at `https://techlyup-service.appneurox.com` | `/v1/module`, `/v1/execute` |
| Inside a brand API | `servicePackage()` mounted by a modular monolith | `/techlyup-service/v1/module`, `/techlyup-service/v1/execute` |

```ts
// Brand API (modular monolith)
import { bootstrapMonolith } from '@appneurox/service-composition';
import { servicePackage } from '@appneurox/techlyup-service';

await bootstrapMonolith({ services: [servicePackage()] });
```

```ts
// Another module in the same process can inject the application directly
import { TechlyupServiceApplication } from '@appneurox/techlyup-service';
```

`servicePackage(options)` passes `options` (extra `providers`, `imports`, `controllers`) to
`TechlyupServiceModule.register()`, which is how a brand configures this service without forking it.

The host owns HTTP, authentication, tenant context, validation, errors, logging and shutdown
through `@appneurox/service-runtime`. Importing this package opens no listener.

**Status: boilerplate.** `GET /v1/module` works; authorized `POST /v1/execute` returns
`501 NOT_IMPLEMENTED` until the business code is written in `src/`.

Client: [`@appneurox/techlyup-service-sdk`](../sdk/README.md).
