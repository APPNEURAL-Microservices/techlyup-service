// Scaffolded by nestjs-fleet scripts/service_packages.py. This file belongs to the service; edit it freely.
import { Injectable } from '@nestjs/common';
import { BaseServiceApplication } from '@appneurox/service-composition';
import { definition } from './definition';

@Injectable()
export class TechlyupServiceApplication extends BaseServiceApplication {
  constructor() { super(definition); }
}
