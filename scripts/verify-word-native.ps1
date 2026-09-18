param([string[]]$Names = @('export', 'failed', 'malformed', 'mobile'), [string]$Revision = 'native')
$ErrorActionPreference = 'Stop'
if ($Revision -notmatch '^[a-z0-9-]+$') { throw 'Invalid QA revision' }
if (Get-Process -Name WINWORD -ErrorAction SilentlyContinue) { throw 'Word is already running; leave user documents untouched.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/playwright'))
$word = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  foreach ($name in $Names) {
    if ($name -notmatch '^[a-z-]+$') { throw 'Invalid fixture name' }
    $source = [IO.Path]::GetFullPath((Join-Path $root "word-$name.docx"))
    $target = [IO.Path]::GetFullPath((Join-Path $root "word-$name-$Revision.pdf"))
    if (-not $source.StartsWith($root + '\') -or -not $target.StartsWith($root + '\')) { throw 'Outside fixture directory' }
    if (Test-Path -LiteralPath $target) { throw "Existing QA output must not be overwritten: $target" }
    $document = $null
    try {
      $document = $word.Documents.Open($source, $false, $true, $false)
      $document.Repaginate()
      $document.ExportAsFixedFormat($target, 17)
      [pscustomobject]@{ file = $name; pages = $document.ComputeStatistics(2); tables = $document.Tables.Count; readOnly = $document.ReadOnly }
    } finally {
      if ($document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) }
    }
  }
} finally {
  if ($word) {
    # A user may open another document during QA. Never close that document or its application.
    if ($word.Documents.Count -eq 0 -and -not $word.Visible) { $word.Quit(0) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  }
}
