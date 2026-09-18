/** File preview is untrusted data, not a tool authorization or a persisted attachment. */
export interface TableImportSheet {
  name: string;
  hidden: boolean;
  rows: string[][];
  hiddenRows: number[];
  hiddenColumns: number[];
  formulaCells: string[];
  missingFormulaCells: string[];
  errorCells: string[];
  mergedRanges: string[];
  dateCells: number;
}

export interface TableImportPreview {
  version: 1;
  file: { name: string; bytes: number; sha256: string; format: 'xlsx' | 'csv' | 'tsv'; encoding?: string };
  sheets: TableImportSheet[];
  warnings: string[];
  requiresConfirmation: true;
  willWrite: false;
  willExecute: false;
}
