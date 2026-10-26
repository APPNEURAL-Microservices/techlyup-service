// Scaffolded by nestjs-fleet scripts/service_packages.py. This file belongs to the service; edit it freely.
import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { ExecuteOperationDto } from '@appneurox/service-composition';
import { Public, RequireScopes, RequireTenant } from '@appneurox/service-runtime';
import { SERVICE_PORT } from './definition';
import { TechlyupServiceApplication } from './application';

@Controller('v1')
export class TechlyupServiceController {
  constructor(@Inject(SERVICE_PORT) private readonly application: TechlyupServiceApplication) {}

  @Public()
  @Get('module')
  metadata() { return this.application.metadata(); }

  @RequireTenant()
  @RequireScopes("techlyup-service:invoke")
  @Post('execute')
  execute(@Body() input: ExecuteOperationDto) { return this.application.execute(input); }
}
