export class ReviewInputError extends TypeError {
  constructor(code, path, message) {
    super(message);
    this.name = 'ReviewInputError';
    this.code = code;
    this.path = path;
  }
}

export function fail(code, path, message) {
  throw new ReviewInputError(code, path, message);
}

export function errorEnvelope(error) {
  return { schema: 'evidence-bound-review/error-v1', error: error instanceof ReviewInputError
    ? { code: error.code, path: error.path, message: error.message }
    : { code: 'internal_error', path: '', message: 'Review could not finish; no review result was produced.' } };
}
