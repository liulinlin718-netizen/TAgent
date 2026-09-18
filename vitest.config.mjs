// Only project tests, never source-release copies or generated runtime files.
export default {
  test: {
    include: [
      'packages/tagent-{ai,core,server,web}/src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
  },
};
