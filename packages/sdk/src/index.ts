// Scaffolded by nestjs-fleet scripts/service_packages.py. This file belongs to the service; edit it freely.
import { createServiceClient } from '@appneurox/sdk-core';
import type { ServiceClient, ServiceClientOptions } from '@appneurox/sdk-core';

export { ApiError } from '@appneurox/sdk-core';
export type { ModuleMetadata, RequestOptions, ServiceClientOptions } from '@appneurox/sdk-core';

export const SERVICE_SLUG = 'techlyup-service';
export const DEFAULT_BASE_URL = 'https://techlyup-service.appneurox.com';

/** Add typed methods for this service's operations here as they are implemented. */
export type TechlyupServiceClient = ServiceClient;

/**
 * Calls the standalone microservice by default. Pass `monolithUrl` to reach the same module
 * through a brand API, which mounts it under `/techlyup-service`.
 */
export function createTechlyupServiceClient(options: ServiceClientOptions = {}): TechlyupServiceClient {
  return createServiceClient(SERVICE_SLUG, DEFAULT_BASE_URL, options);
}
