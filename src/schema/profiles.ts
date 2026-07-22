export type JSONSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  $ref?: string;
  $defs?: Record<string, unknown>;
  definitions?: Record<string, unknown>;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
  [key: string]: unknown;
};

const TYPE_PRIORITY = ['object', 'array', 'integer', 'number', 'string', 'boolean'];

export function applySchemaProfile(schema: JSONSchema | undefined | null, profile: string): JSONSchema | undefined | null {
  if (!schema) return schema;
  if (profile === 'gemini') {
    return simplifySchemaForGemini(schema);
  }
  return schema;
}

export function simplifySchemaForGemini(schema: JSONSchema): JSONSchema {
  const rootDefs = collectDefs(schema);
  return simplifySchema(schema, rootDefs);
}

function collectDefs(schema: JSONSchema): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  const sources = [schema.$defs, schema.definitions];
  for (const source of sources) {
    if (source && typeof source === 'object') {
      Object.assign(defs, source);
    }
  }
  return defs;
}

function resolveRef(ref: string, defs: Record<string, unknown>): JSONSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.replace(/^#\//, '').split('/');
  if (parts.length === 2 && (parts[0] === '$defs' || parts[0] === 'definitions')) {
    const candidate = defs[parts[1]!];
    if (candidate && typeof candidate === 'object') {
      return { ...(candidate as JSONSchema) };
    }
  }
  return undefined;
}

function selectVariant(variants: unknown[], defs: Record<string, unknown>): JSONSchema | undefined {
  const resolved: JSONSchema[] = [];
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') continue;
    const v = variant as JSONSchema;
    if (v.$ref && typeof v.$ref === 'string') {
      const resolvedVariant = resolveRef(v.$ref, defs);
      if (resolvedVariant) {
        resolved.push(resolvedVariant);
        continue;
      }
    }
    resolved.push(v);
  }

  const nonNull = resolved.filter((item) => {
    if (Array.isArray(item.type)) return !item.type.includes('null');
    return item.type !== 'null';
  });

  const candidates = nonNull.length > 0 ? nonNull : resolved;
  if (candidates.length === 0) return undefined;

  function score(item: JSONSchema): number {
    let schemaType = Array.isArray(item.type) ? item.type[0] : item.type;
    if (!schemaType) {
      if (item.properties && typeof item.properties === 'object') {
        schemaType = 'object';
      } else if (item.items) {
        schemaType = 'array';
      }
    }
    const idx = TYPE_PRIORITY.indexOf(schemaType ?? '');
    return idx === -1 ? TYPE_PRIORITY.length : idx;
  }

  return candidates.sort((a, b) => score(a) - score(b))[0];
}

function simplifySchema(schema: unknown, defs: Record<string, unknown>): JSONSchema {
  if (!schema || typeof schema !== 'object') return {};
  const s = schema as JSONSchema;

  const localDefs = { ...defs };
  const sources = [s.$defs, s.definitions];
  for (const source of sources) {
    if (source && typeof source === 'object') {
      Object.assign(localDefs, source);
    }
  }

  if (s.$ref && typeof s.$ref === 'string') {
    const resolved = resolveRef(s.$ref, localDefs);
    if (resolved) return simplifySchema(resolved, localDefs);
  }

  const combinationKeys = ['anyOf', 'oneOf', 'allOf'] as const;
  for (const key of combinationKeys) {
    const variants = s[key];
    if (Array.isArray(variants)) {
      const selected = selectVariant(variants, localDefs);
      if (selected) return simplifySchema(selected, localDefs);
    }
  }

  let schemaType = s.type;
  if (Array.isArray(schemaType)) {
    const nonNull = schemaType.filter((t) => t !== 'null');
    schemaType = nonNull[0];
  }

  if (!schemaType) {
    if (s.properties && typeof s.properties === 'object') {
      schemaType = 'object';
    } else if (s.items) {
      schemaType = 'array';
    }
  }

  const description = typeof s.description === 'string' ? s.description : undefined;

  if (schemaType === 'object') {
    const properties = s.properties;
    const simplifiedProps: Record<string, unknown> = {};
    if (properties && typeof properties === 'object') {
      for (const [key, value] of Object.entries(properties)) {
        simplifiedProps[key] = simplifySchema(value, localDefs);
      }
    }
    const result: JSONSchema = {
      type: 'object',
      properties: simplifiedProps,
    };
    if (Array.isArray(s.required)) {
      result.required = s.required.filter((key) => Object.prototype.hasOwnProperty.call(simplifiedProps, key));
    }
    if (description) result.description = description;
    return result;
  }

  if (schemaType === 'array') {
    let itemsSchema: JSONSchema;
    if (Array.isArray(s.items) && s.items.length > 0) {
      itemsSchema = simplifySchema(s.items[0], localDefs);
    } else if (s.items && typeof s.items === 'object') {
      itemsSchema = simplifySchema(s.items, localDefs);
    } else {
      itemsSchema = {};
    }
    const result: JSONSchema = {
      type: 'array',
      items: itemsSchema,
    };
    if (description) result.description = description;
    return result;
  }

  const result: JSONSchema = {};
  if (typeof schemaType === 'string') result.type = schemaType;
  if (Array.isArray(s.enum)) result.enum = s.enum;
  if (description) result.description = description;
  return result;
}
