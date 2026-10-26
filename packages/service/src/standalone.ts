// Scaffolded by nestjs-fleet scripts/service_packages.py. This file belongs to the service; edit it freely.
import { bootstrapService, createServiceApplication, loadServiceConfig } from '@appneurox/service-runtime';
import type { BootstrapOptions, ServiceApplicationOptions } from '@appneurox/service-runtime';
import { definition } from './definition';
import { TechlyupServiceModule } from './module';

export type StandaloneApplicationOptions = Pick<ServiceApplicationOptions, 'env' | 'logger' | 'authVerifier'>;
export type StandaloneBootstrapOptions = StandaloneApplicationOptions & Pick<BootstrapOptions, 'handleSignals'>;

function fixedConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return loadServiceConfig({ ...env, SERVICE_NAME: definition.slug, CATALOG_SLUG: definition.slug,
    SERVICE_CAPABILITY_LABEL: definition.label });
}

export async function createStandaloneApplication(options: StandaloneApplicationOptions = {}) {
  return createServiceApplication({ config: fixedConfiguration(options.env), imports: [TechlyupServiceModule.register()],
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.authVerifier === undefined ? {} : { authVerifier: options.authVerifier }) });
}

export async function bootstrapStandalone(options: StandaloneBootstrapOptions = {}) {
  return bootstrapService({ config: fixedConfiguration(options.env), imports: [TechlyupServiceModule.register()],
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.authVerifier === undefined ? {} : { authVerifier: options.authVerifier }),
    ...(options.handleSignals === undefined ? {} : { handleSignals: options.handleSignals }) });
}

if (require.main === module) {
  void bootstrapStandalone().catch(() => { console.error('Standalone service startup failed'); process.exitCode = 1; });
}
