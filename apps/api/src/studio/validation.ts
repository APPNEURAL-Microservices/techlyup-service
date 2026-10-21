import { z } from 'zod';
import { ApiError } from '../types';
import type { WorkspaceField, WorkspaceResource, WorkspaceValue } from './contracts';

function fieldSchema(field: WorkspaceField): z.ZodType {
  let schema: z.ZodType;
  if (field.type === 'number') {
    let value = z.number().finite().min(field.min ?? 0).max(field.max ?? 10000000);
    if (/Minor$|Minutes$|^(position|capacity)$/.test(field.name)) value = value.int();
    schema = value;
  } else if (field.type === 'checkbox') {
    schema = field.required ? z.literal(true) : z.boolean();
  } else {
    let value = z.string().trim().max(field.max ?? (field.type === 'textarea' ? 4000 : 200));
    if (field.required) value = value.min(1);
    if (field.type === 'date') value = value.refine(text => !text && !field.required || /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text, 'Use a valid calendar date.');
    if (field.type === 'datetime-local') value = value.refine(text => !text && !field.required || /^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text)), 'Use a valid date and time.');
    if (field.type === 'select') value = value.refine(text => field.options?.some(option => option.value === text), 'Choose a listed option.');
    if (field.type === 'url') value = value.refine(text => {
      if (!text && !field.required) return true;
      try {
        const address = new URL(text);
        const privateKeys = new Set(['token','accesstoken','refreshtoken','idtoken','secret','password','signature','sig','apikey','key','authorization','auth','credential','code','passcode','jwt','session','ticket']);
        return address.protocol === 'https:' && !address.username && !address.password && !address.hash && ![...address.searchParams.keys()].some(key => {
          const normalized = key.toLowerCase().replaceAll(/[-_.]/g, '');
          return privateKeys.has(normalized) || normalized.startsWith('xamz') || normalized.startsWith('xgoog');
        });
      } catch { return false; }
    }, 'Use a public HTTPS address without credentials or private access parameters.');
    schema = value;
  }
  return field.required ? schema : schema.optional();
}

export function validateValues(resource: WorkspaceResource, input: unknown): Record<string, WorkspaceValue> {
  const shape = Object.fromEntries(resource.fields.map(field => [field.name, fieldSchema(field)]));
  const result = z.object(shape).strict().safeParse(input);
  if (!result.success) throw new ApiError('validation_failed', 'Check the marked draft fields.', 422, Object.fromEntries(result.error.issues.map(issue => [issue.path.join('.') || 'values', issue.message])));
  const values = result.data as Record<string, WorkspaceValue>;
  if (JSON.stringify(values).length > 16000) throw new ApiError('request_too_large', 'Keep this draft below the workspace content limit.', 413);
  if (typeof values.timezone === 'string') {
    try { new Intl.DateTimeFormat('en', { timeZone: values.timezone }).format(); }
    catch { throw new ApiError('validation_failed', 'Use a recognized timezone such as Asia/Kolkata.', 422, { timezone: 'Choose a valid IANA timezone.' }); }
  }
  for (const name of ['startsAt', 'endsAt', 'preferredTime']) {
    if (typeof values[name] === 'string' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values[name])) throw new ApiError('validation_failed', 'Use a time in HH:mm format.', 422, { [name]: 'Use HH:mm in 24-hour format.' });
  }
  if (typeof values.startsAt === 'string' && typeof values.endsAt === 'string' && values.endsAt <= values.startsAt) throw new ApiError('validation_failed', 'The availability end must follow its start.', 422, { endsAt: 'Choose an end time after the start.' });
  if (typeof values.startsOn === 'string' && typeof values.endsOn === 'string' && values.endsOn < values.startsOn) throw new ApiError('validation_failed', 'The end date must follow the start date.', 422, { endsOn: 'Choose an end date on or after the start.' });
  for (const name of ['learnerReference', 'assignmentReference', 'audienceReference']) {
    if (typeof values[name] === 'string' && !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(values[name])) throw new ApiError('validation_failed', 'Use an authorized reference identifier, not a name or contact address.', 422, { [name]: 'Use an opaque reference identifier without contact details.' });
  }
  // The directory is a reference notebook, not a contact-import surface.
  if (['directory', 'details', 'groups', 'communication'].includes(resource.id) && Object.values(values).some(value => typeof value === 'string' && /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value))) throw new ApiError('validation_failed', 'Keep learner contact details in the canonical authorized learner system.', 422);
  return values;
}
