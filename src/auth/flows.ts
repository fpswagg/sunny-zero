import type { SecretStore } from '../secrets/store.ts';
import type { AuthFlow, Field, Link, Screen } from './types.ts';

export interface FormFlowOptions {
  title: string;
  description?: string;
  fields: Field[];
  links?: Link[];
  /** Secret id the values are stored under. */
  secretId: string;
  label?: string;
  /** Check the values before saving (e.g. try an IMAP login). Return an error message to re-ask. */
  validate?: (values: Record<string, string>) => Promise<string | undefined>;
  onSaved?: (values: Record<string, string>) => Promise<void>;
}

export function isSecretField(field: Field): boolean {
  return field.secret ?? field.type === 'password';
}

/** Missing required fields, by label. */
export function missingFields(fields: Field[], values: Record<string, string>): string[] {
  return fields.filter((f) => !f.optional && !values[f.name]?.trim()).map((f) => f.label);
}

/** Keep what the user typed in non-secret fields when the form is shown again. */
export function refill(fields: Field[], values: Record<string, string>): Field[] {
  return fields.map((f) => (isSecretField(f) ? f : { ...f, value: values[f.name] ?? f.value }));
}

/** One form whose values are stored as a single secret. */
export function formFlow(secrets: SecretStore, opts: FormFlowOptions): AuthFlow {
  const form = (error?: string, values: Record<string, string> = {}): Screen => ({
    kind: 'form',
    title: opts.title,
    description: opts.description,
    fields: refill(opts.fields, values),
    links: opts.links,
    submitLabel: 'Save',
    error,
  });

  return {
    title: opts.title,
    start: async () => form(),
    submit: async (raw) => {
      const values: Record<string, string> = {};
      for (const f of opts.fields) {
        const v = raw[f.name]?.trim();
        if (v) values[f.name] = v;
      }
      const missing = missingFields(opts.fields, values);
      if (missing.length) return form(`Please fill in: ${missing.join(', ')}`, values);
      const problem = await opts.validate?.(values);
      if (problem) return form(problem, values);
      await secrets.set(opts.secretId, values, { kind: 'form', label: opts.label ?? opts.title });
      await opts.onSaved?.(values);
      return { kind: 'done', title: opts.title, message: 'Saved. You can close this page and go back to the chat.' };
    },
  };
}
