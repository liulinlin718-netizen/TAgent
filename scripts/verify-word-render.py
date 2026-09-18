"""Read native Word QA PDFs and rasterize them; never edit the source documents."""
from pathlib import Path
import json
import argparse
import pdfplumber
import pypdfium2 as pdfium

root = Path(__file__).resolve().parent.parent / 'output' / 'playwright'
parser = argparse.ArgumentParser()
parser.add_argument('--revision', default='native')
revision = parser.parse_args().revision
assert revision and all(char in 'abcdefghijklmnopqrstuvwxyz0123456789-' for char in revision)
for name in ('export', 'failed', 'malformed', 'mobile'):
    source = root / f'word-{name}-{revision}.pdf'
    document = pdfplumber.open(source)
    rendered = pdfium.PdfDocument(source)
    text = '\n'.join(page.extract_text() or '' for page in document.pages)
    assert '导出与核对记录' in text
    assert '\ufffd' not in text
    if name in ('export', 'mobile'):
        for value in ('甲|乙', '负责人', '统计口径', '310', 'https://example.com/report'):
            assert value in text, (name, value)
    if name == 'failed':
        assert '任务未完整完成' in text and '320' in text and '未通过' in text
    if name == 'malformed':
        assert '尚未完成核对' in text
    for index, page in enumerate(document.pages):
        for word in page.extract_words():
            assert word['x0'] >= 0 and word['top'] >= 0 and word['x1'] <= page.width + 1 and word['bottom'] <= page.height + 1, (name, index, word)
        rendered[index].render(scale=1.5).to_pil().save(root / f'word-{name}-{revision}-page-{index + 1}.png')
    print(json.dumps({'file': name, 'pages': len(document.pages), 'textCharacters': len(text), 'pageBounds': True}))
    rendered.close()
    document.close()
