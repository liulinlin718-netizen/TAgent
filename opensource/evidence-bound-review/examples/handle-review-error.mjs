import { reviewReport, ReviewInputError, errorEnvelope } from '../src/index.js';

// A synthetic invalid binding: callers can highlight this field without parsing prose.
try {
  reviewReport({
    requirements: { id: 'brief', text: 'Review only the supplied material.' },
    report: 'Synthetic report.',
    materials: [{ id: 'source', text: 'No date was supplied.', source: {
      basis: 'publication', dateQuote: 'Published: 2026-09-25',
    } }],
  });
} catch (error) {
  if (!(error instanceof ReviewInputError)) throw error;
  console.log(JSON.stringify(errorEnvelope(error), null, 2));
}
