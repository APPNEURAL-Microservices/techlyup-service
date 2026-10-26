// Scaffolded by nestjs-fleet scripts/service_packages.py. This file belongs to the service; edit it freely.
import { serviceApplicationToken } from '@appneurox/service-composition';
import type { ServiceDefinition } from '@appneurox/service-composition';

export const definition: Readonly<ServiceDefinition> = Object.freeze({
  slug: "techlyup-service",
  label: "Techlyup Service",
});
export const SERVICE_PORT = serviceApplicationToken(definition.slug);
