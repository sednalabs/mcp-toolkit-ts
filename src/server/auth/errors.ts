export class AuthError extends Error {
  status: number;
  code: string;
  reason: string;
  hint?: string;

  constructor(message: string, opts: { status: number; code: string; reason: string; hint?: string }) {
    super(message);
    this.name = 'AuthError';
    this.status = opts.status;
    this.code = opts.code;
    this.reason = opts.reason;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
