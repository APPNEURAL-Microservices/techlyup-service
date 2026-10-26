// Scaffolded by nestjs-fleet scripts/service_packages.py. This file belongs to the service; edit it freely.
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { composeServiceModule } from '@appneurox/service-composition';
import type { ServiceModuleOptions } from '@appneurox/service-composition';
import { definition } from './definition';
import { TechlyupServiceApplication } from './application';
import { TechlyupServiceController } from './controller';

@Module({})
export class TechlyupServiceModule {
  private static defaultRegistration: DynamicModule | undefined;

  static register(options: ServiceModuleOptions = {}): DynamicModule {
    if (Reflect.ownKeys(options).length === 0) {
      if (TechlyupServiceModule.defaultRegistration === undefined) {
        TechlyupServiceModule.defaultRegistration = composeServiceModule(TechlyupServiceModule, definition, TechlyupServiceApplication, { controllers: [TechlyupServiceController] });
      }
      return TechlyupServiceModule.defaultRegistration;
    }
    // Register custom options once and re-export that explicit registration.
    return composeServiceModule(TechlyupServiceModule, definition, TechlyupServiceApplication, { ...options, controllers: [TechlyupServiceController, ...(options.controllers ?? [])] });
  }
}
