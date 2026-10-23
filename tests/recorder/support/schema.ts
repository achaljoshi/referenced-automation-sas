/**
 * A small JSON Schema checker for the subset RECORDING_JSON_SCHEMA uses (type, const, enum, required, properties, additionalProperties, items, minItems,
 * minLength, minimum, oneOf, anyOf, not, $ref into #/$defs): enough to check that the schema and the validator agree. Returns the problems found.
 */
type Schema = Record<string, unknown>;

export function validateAgainstSchema(root: unknown, value: unknown): string[] {
  const rootSchema = root as Schema;
  const resolve = (schema: Schema): Schema => {
    const ref = schema.$ref as string | undefined;
    if (!ref) return schema;
    const name = ref.replace('#/$defs/', '');
    return (rootSchema.$defs as Record<string, Schema>)[name] as Schema;
  };
  const check = (schemaIn: Schema, v: unknown, at: string): string[] => {
    const schema = resolve(schemaIn);
    const out: string[] = [];
    if ('const' in schema && v !== schema.const) out.push(`${at}: must be ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(v)) out.push(`${at}: must be one of ${schema.enum.join(', ')}`);
    const type = schema.type as string | undefined;
    const kind = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v;
    if (type && !(type === kind || (type === 'number' && kind === 'integer'))) return [...out, `${at}: must be ${type}`];
    if (typeof v === 'string' && typeof schema.minLength === 'number' && v.length < schema.minLength) out.push(`${at}: too short`);
    if (typeof v === 'number' && typeof schema.minimum === 'number' && v < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (Array.isArray(v)) {
      if (typeof schema.minItems === 'number' && v.length < schema.minItems) out.push(`${at}: too few items`);
      if (schema.items) v.forEach((item, i) => out.push(...check(schema.items as Schema, item, `${at}[${i}]`)));
    }
    if (kind === 'object') {
      const object = v as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) if (object[key] === undefined) out.push(`${at}.${key}: required`);
      const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
      for (const [key, item] of Object.entries(object)) {
        if (item === undefined) continue;
        if (properties[key]) out.push(...check(properties[key] as Schema, item, `${at}.${key}`));
        else if (schema.additionalProperties === false) out.push(`${at}.${key}: not allowed`);
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const matching = (schema.oneOf as Schema[]).filter((s) => check(s, v, at).length === 0).length;
      if (matching !== 1) out.push(`${at}: must match exactly one alternative (matches ${matching})`);
    }
    if (Array.isArray(schema.anyOf) && !(schema.anyOf as Schema[]).some((s) => check(s, v, at).length === 0)) out.push(`${at}: must match one alternative`);
    if (schema.not && check(schema.not as Schema, v, at).length === 0) out.push(`${at}: must not match`);
    return out;
  };
  return check(rootSchema, value, '$');
}
