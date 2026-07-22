export type AllowedTokenClaim =
  | 'aud'
  | 'exp'
  | 'iss'
  | 'azp'
  | 'client_id'
  | 'resource'
  | 'token_type'
  | 'typ';

type AllowedTokenClaimMap = {
  aud?: string | string[];
  exp?: number;
  iss?: string;
  azp?: string;
  client_id?: string;
  resource?: string | string[];
  token_type?: string;
  typ?: string;
};

const ALLOWED_TOKEN_CLAIMS: AllowedTokenClaim[] = [
  'aud',
  'exp',
  'iss',
  'azp',
  'client_id',
  'resource',
  'token_type',
  'typ',
];

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim());
  const compact = filtered.filter((entry) => entry.length > 0);
  return compact.length > 0 ? compact : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class NonAuthoritativeClaims {
  private readonly _claims: Readonly<AllowedTokenClaimMap>;

  private constructor(claims: AllowedTokenClaimMap) {
    this._claims = Object.freeze({ ...claims });
  }

  static fromRaw(raw: Record<string, unknown>): NonAuthoritativeClaims {
    const filtered: AllowedTokenClaimMap = {};
    for (const key of ALLOWED_TOKEN_CLAIMS) {
      const value = raw[key];
      switch (key) {
        case 'aud':
        case 'resource': {
          const asString = readString(value);
          const asArray = readStringArray(value);
          if (asArray) {
            filtered[key] = asArray;
          } else if (asString) {
            filtered[key] = asString;
          }
          break;
        }
        case 'exp': {
          const asNumber = readNumber(value);
          if (asNumber !== undefined) {
            filtered.exp = asNumber;
          }
          break;
        }
        case 'iss':
        case 'azp':
        case 'client_id':
        case 'token_type':
        case 'typ': {
          const asString = readString(value);
          if (asString) {
            filtered[key] = asString;
          }
          break;
        }
        default:
          break;
      }
    }
    return new NonAuthoritativeClaims(filtered);
  }

  get<K extends AllowedTokenClaim>(name: K): AllowedTokenClaimMap[K] | undefined {
    return this._claims[name] as AllowedTokenClaimMap[K] | undefined;
  }

  has(name: AllowedTokenClaim): boolean {
    return this.get(name) !== undefined;
  }

  toJSON(): AllowedTokenClaimMap {
    return { ...this._claims };
  }
}
