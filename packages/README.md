# Packages

| Directory | npm package | Purpose |
| --- | --- | --- |
| [`service/`](service/README.md) | `@appneurox/techlyup-service` | Techlyup Service NestJS module: standalone microservice or a module inside any brand API |
| [`sdk/`](sdk/README.md) | `@appneurox/techlyup-service-sdk` | Client for either deployment |

All changes to Techlyup Service are made here. Brand APIs (APPNEURAL-APIServices/&lt;brand&gt;-api) only
pin a version range and pass configuration.

## Releasing a change

1. Change the code in `service/src` (and add typed client methods in `sdk/src`).
2. Bump both packages to the same version, following semver:
   - patch `0.1.1`: fixes, no API change
   - minor `0.2.0`: new operations or options (while below 1.0 a minor bump may break callers)
   - major `1.0.0`+: breaking change once stable
   ```sh
   (cd service && npm version minor --no-git-tag-version)
   (cd sdk && npm version minor --no-git-tag-version)
   ```
3. Commit, tag `v<version>`, push. The release job publishes both packages to npm
   under the `@appneurox` scope and deploys the standalone service from the `live` branch.
4. Each brand API picks the change up by widening its range in `brand.json` and running
   `npm run sync && npm install`.
