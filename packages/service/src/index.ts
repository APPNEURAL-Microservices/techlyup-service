// Scaffolded by nestjs-fleet scripts/service_packages.py. This file belongs to the service; edit it freely.
import type { ServicePackage, ServiceModuleOptions } from '@appneurox/service-composition';
import { definition, SERVICE_PORT } from './definition';
import { TechlyupServiceModule } from './module';

export { definition, SERVICE_PORT } from './definition';
export { TechlyupServiceModule } from './module';
export { TechlyupServiceApplication } from './application';
export { TechlyupServiceController } from './controller';

/** What a modular monolith mounts. Options are passed to `TechlyupServiceModule.register()`. */
export function servicePackage(options: ServiceModuleOptions = {}): ServicePackage {
  return { definition, module: TechlyupServiceModule.register(options), applicationToken: SERVICE_PORT };
}
