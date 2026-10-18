# Existing APPNEUROX platform client

This server-only package consumes the existing Cloudflare `edge-monolith` under `Microservices/cloudflare`; it implements no replacement identity, user, access, configuration, feature-flag or audit service. It lives under the Microservices workspace so product apps consume contracts and product endpoints rather than embed shared-service credentials.

The API exposes only three fixed operations: Boolean feature evaluation, allowlisted scalar configuration resolution and audit-capability reads. There is no arbitrary path/URL/tenant proxy, credential creation, raw audit-event export or business mutation method.

| Existing operation | Contract / authority |
| --- | --- |
| GET `/v1/authentication/me` | Requires a current tenant-bound `SERVICE` principal. The client rejects USER, another tenant, missing permissions and overprivileged `platform.admin` credentials before the requested operation. |
| POST `/v1/featureflag/evaluate/batch` | `{projectId,environmentId,context:{targetingKey},flags:[{flagKey,fallbackValue:false}]}`; requires `featureflag.evaluate`. The existing service returns an array including value/revision/snapshotRevision. Client returns only exact allowlisted Boolean values and one coherent snapshot revision. |
| POST `/v1/config/configurations/resolve` | Fixed namespace/project/environment plus `includeResolutionMetadata:false`; requires `config.read`, an owned namespace and active ancestry. Client returns only explicitly allowlisted finite scalar values, bounded strings and revision. |
| GET `/v1/audit/capabilities` | Requires `audit.read`. Returns bounded typed capability booleans. Existing edge implementation explicitly reports `clientEventIngestion:false`; this client does not claim audit ingestion. |

Every call sends the private SERVICE Bearer credential, exact platform `Origin` and fixed `X-Tenant-ID`. There is no separate edge application-key header. Permission and current principal state are rechecked by the platform and by this client. Scope is configured on the server and never copied from an end-user request.

The existing platform caps access/opaque credential lifetime at 900 seconds. `PLATFORM_SERVICE_CREDENTIAL` therefore means a currently valid short-lived credential, never a permanent API key. Production activation requires an accepted credential renewal/rotation provider with durable private storage or controlled fresh credential injection. This client deliberately provisions no principal/grant and performs no automatic refresh without that storage contract. The default-off local bridge is not a claim that a live credential lifecycle has been provisioned.

The destination is pinned to `https://api.appneurox.com`; explicit local mode permits HTTP loopback only. Requests use a three-second abort deadline, reject redirects, require JSON, cap streamed responses at 64 KiB and discard upstream error text. There are no automatic retries, source token logs, query strings, client-provided targets or fallback claims of upstream success.

In the TechlyUp adapter, `APP_PLATFORM_ENABLED=false` by default. `/api/v1/featureflags` exposes only `techlyup.app.learning-sync` and `techlyup.app.analytics`, each additionally restricted by its local backend feature flag. Disabled bridge responses explicitly say `source:'disabled'`; enabled upstream failures return 503. `/api/v1/platform/capabilities` requires the caller's current canonical TechlyUp administrator permission before using the server's SERVICE credential, and returns only sanitized measured capabilities/counts/revisions. The SERVICE principal's authority is never granted to the caller.

Acceptance includes ordinary malformed/denied/oversize response tests and an actual disposable Miniflare/D1 test using the existing edge-monolith authentication, workspace, flag, config and audit dispatch code plus its real migrations. Local synthetic USER ownership establishes an active project/environment; a separate tenant-bound SERVICE principal performs reads. Wrong-tenant selection and current permission withdrawal are rejected. No production principal, grant, configuration or flag is created by these tests.

The neighboring source contract test intentionally depends on `Microservices/cloudflare/edge-monolith/test/runtime-harness.ts`. The package's runtime imports do not depend on that source tree. If the shared platform changes, this integration test must be rerun before updating a consumed client artifact. Current local compatibility is distinct from live credentials, platform provisioning and production activation.
