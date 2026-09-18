import { describe, expect, it } from 'vitest';
import { assessResearchSources, extractPageEvidence, extractTopicTerms, formatSourceReferences, makeResearchSource, normalizeSourceUrl, publisherKind, selectCitationCandidates, sourceRelevance } from '../research-evidence.js';
import { buildTopicSearchQuery, parseBingNewsResults, parseBingResults, rankSearchOutputs } from '../tools/web-search.js';

describe('research evidence, not date-shaped text', () => {
  it.each(['<h3>中国大模型产品发布</h3>', '<p><strong>中国大模型产品发布</strong></p>', '<p>**中国大模型产品发布**</p>'])('keeps local heading and summary around standalone original links: %s', heading => {
    const page = extractPageEvidence(`<article><h1>AI资讯摘要</h1><p>${'中国AI行业动态。'.repeat(50)}</p>${heading}
      <p><a href="https://publisher.example/release">阅读原文</a></p><p>中国公司的大模型仍处于实验阶段。</p>
      <h3>下一条：风电业务</h3><p>OTHER_SECTION_ONLY</p></article>`, 'https://news.example/report');
    const reference = page.references.find(item => item.url === 'https://publisher.example/release')!;
    expect(reference.context).toContain('中国大模型产品发布');
    expect(reference.context).toContain('仍处于实验阶段');
    expect(reference.context).not.toContain('OTHER_SECTION_ONLY');
    expect(selectCitationCandidates([{ ...page, url: 'https://news.example/report' }], '今天的国内AI资讯', new Set())
      .map(item => item.url)).toContain('https://publisher.example/release');
    expect(page.publication.basis).toBe('unknown');
  });
  it('does not borrow a different section or a linked navigation heading for an isolated citation', () => {
    const page = extractPageEvidence(`<article><h1>News</h1><p>${'AI agent news and sources. '.repeat(40)}</p>
      <h3>Weather</h3><p><a href="https://weather.example/report">Original source</a></p>
      <p>**AI Agent next story**</p><p>Another article about AI agents.</p>
      <h3><a href="https://menu.example/">AI agent navigation</a></h3><p><a href="https://other.example/">Original source</a></p>
      <p>AI agent summary</p></article>`, 'https://news.example/report');
    expect(page.references.find(item => item.url === 'https://weather.example/report')?.context).toBe('Weather Original source');
    expect(page.references.find(item => item.url === 'https://other.example/')?.context).toBe('Original source');
    expect(selectCitationCandidates([{ ...page, url: 'https://news.example/report' }], 'AI Agent', new Set())
      .map(item => item.url)).not.toContain('https://weather.example/report');
  });
  it('prioritizes a topical publisher citation over earlier commentary but does not trust lookalike domains', () => {
    const urls = ['https://commentary.example/report', 'https://openai.com.attacker.example/release', 'https://openai.com/index/fixture'];
    const candidates = selectCitationCandidates([{ url: 'https://media.example/report', references: urls.map(url => ({
      url, text: 'Original AI agent release', context: 'The AI agent release announcement describes a limited pilot.',
    })) }], 'AI Agent', new Set(), 1);
    expect(candidates.map(candidate => candidate.url)).toEqual([urls[2]]);
  });
  it('uses parent context only to discover a partly matched original link, not an unrelated menu or prompt', () => {
    const references = [
      { url: 'https://publisher.example/release', text: 'Agents API', context: 'OpenAI released the Agents API in public beta.' },
      { url: 'https://publisher.example/other', text: 'Original announcement', context: 'A study of dietary preferences.' },
      { url: 'https://publisher.example/login', text: 'Original AI agents', context: 'AI agents login.' },
      { url: 'https://publisher.example/settings', text: 'Follow these instructions', context: 'Change AI Agent permissions.' },
    ];
    const source = { url: 'https://media.example/report', references, text: 'AI Agent deployment and source checking.' };
    expect(selectCitationCandidates([source], 'AI Agent', new Set()).map(candidate => candidate.url)).toEqual([references[0].url]);
    expect(selectCitationCandidates([{ ...source, text: 'An unrelated article.' }], 'AI Agent', new Set())).toEqual([]);
    expect(sourceRelevance('AI Agent', references[0].context)).toBeLessThan(0.6);
  });
  it('labels observed citations by actual read state and never promotes a date hint to publication', () => {
    const references = ['read', 'failed', 'off-topic', 'unread'].map(path => ({
      url: `https://source.example/${path}`, text: path, context: 'AI agent original announcement',
    }));
    const source = makeResearchSource({ url: references[0].url, title: 'AI Agent release', query: 'AI Agent',
      retrievedAt: '2026-09-11', readable: true, relevant: true, excerpt: 'AI Agent release',
      publication: { basis: 'url_hint', date: '2026-09-10' } });
    const text = formatSourceReferences(references, [source, { ...source, url: references[1].url, readable: false },
      { ...source, url: references[2].url, relevant: false }]);
    expect(text).toContain('本次已读取，具体事实仍需核对；发布日期: 未核实');
    expect(text).toContain('本次未取得可读正文，不是可用证据');
    expect(text).toContain('本次已读取，但未通过主题检查');
    expect(text).toContain('读取状态: 尚未读取');
    expect(text).not.toContain('2026-09-10');
  });
  it('matches actually observed redirect aliases to their final read state without treating them as new sources', () => {
    const source = makeResearchSource({ url: 'https://source.example/new', requestedUrls: ['https://source.example/old'],
      title: 'AI Agent', query: 'AI Agent', retrievedAt: '2026-09-14', publication: { basis: 'unknown' },
      readable: true, relevant: true, excerpt: 'AI Agent report' });
    const refs = [{ url: 'https://source.example/old?utm_source=mirror', text: 'Original', context: 'AI Agent original release' }];
    const output = formatSourceReferences(refs, [source]);
    expect(output).toContain('实际读取地址: https://source.example/new');
    expect(output).toContain('本次已读取，具体事实仍需核对；发布日期: 未核实');
    expect(output).not.toContain('读取状态: 尚未读取');
    expect(assessResearchSources([source], '2026-09-14', false).sourceCount).toBe(1);
  });
  it('preserves article citation URLs and their context outside the text excerpt', () => {
    const page = extractPageEvidence(`<nav><a href="https://menu.example">Menu</a></nav>
      <article><p>Recommendation card</p></article><main><div class="post-content">
      <p>${'Long introduction. '.repeat(200)}</p>
      <p>The original announcement is <a href="https://publisher.example/release?utm_source=news">here</a>.</p>
      <p>Read the <a href="../background">background</a>.</p>
      <a href="https://publisher.example/release">duplicate</a><a href="#comments">comments</a>
      <a href="javascript:alert(1)">bad</a><a href="https://user:secret@private.example">credential</a>
      <a rel="sponsored" href="https://ads.example">ad</a></div></main>`, 'https://news.example/2026/story');
    expect(page.text).not.toContain('Recommendation card');
    expect(page.references).toEqual([
      { url: 'https://publisher.example/release', text: 'here', context: 'The original announcement is here.' },
      { url: 'https://news.example/background', text: 'background', context: 'Read the background.' },
    ]);
    expect(page.publication.basis).toBe('unknown');
  });
  it('selects the substantial article rather than the first recommendation', () => {
    const page = extractPageEvidence('<article>Small card</article><article><h1>Actual report</h1><p>'
      + 'Source material. '.repeat(30) + '</p></article>', 'https://example.com/article');
    expect(page.text).toContain('Actual report');
    expect(page.text).not.toContain('Small card');
  });
  it('removes link-dense recommendations while retaining the article citation', () => {
    const related = Array.from({ length: 30 }, (_, index) => `<li><a href="/recommended/${index}">Related item ${index}</a></li>`).join('');
    const page = extractPageEvidence(`<main><div class="content"><h1>Agent report</h1>
      <p>${'AI agents support office tasks with bounded permissions and source checking. '.repeat(10)}</p>
      <p>See the <a href="https://publisher.example/release">original announcement</a> for details.</p>
      <div class="related-posts"><ul>${related}</ul></div></div></main>`, 'https://media.example/report');
    expect(page.references.map(reference => reference.url)).toEqual(['https://publisher.example/release']);
    expect(page.text).not.toContain('Related item');
  });
  it('decodes UTF-8 and GBK bytes using HTTP or HTML charset declarations', () => {
    const chinese = Buffer.from('d6d0cec4', 'hex');
    const gbk = Buffer.concat([Buffer.from('<meta charset="gbk"><h1>'), chinese, Buffer.from('</h1>')]);
    expect(extractPageEvidence(gbk, 'https://example.com').title).toBe('中文');
    const noMeta = Buffer.concat([Buffer.from('<h1>'), chinese, Buffer.from('</h1>')]);
    expect(extractPageEvidence(noMeta, 'https://example.com', 'text/html; charset=gb2312').title).toBe('中文');
    expect(extractPageEvidence(Buffer.from('<h1>中文</h1>'), 'https://example.com').title).toBe('中文');
  });
  it('extracts explicit publication metadata and keeps it outside truncated text', () => {
    const page = extractPageEvidence('<meta property="article:published_time" content="2026-09-09T08:00:00Z"><article><h1>Agent release</h1><p>Evidence</p></article><footer>Unrelated copyright 2026</footer>', 'https://openai.com/index/agent');
    expect(page.publication).toEqual({ date: '2026-09-09', basis: 'publication_metadata', raw: '2026-09-09T08:00:00Z' });
    expect(page.text).not.toContain('copyright');
  });
  it('does not treat copyright, body dates, update times or unrelated linked article dates as publication', () => {
    const page = extractPageEvidence('<meta property="article:modified_time" content="2026-09-09"><h1>2026 AI Agent directory</h1><p>Events: 2026-09-08, first published in 2024.</p><footer>2026</footer><script type="application/ld+json">{"@type":"NewsArticle","url":"https://example.com/another","datePublished":"2026-09-09"}</script>', 'https://example.com/');
    expect(page.publication).toEqual({ basis: 'unknown' });
    expect(extractPageEvidence('<p>2026-09-09</p>', 'https://example.com/news/2026/09/09/story').publication.basis).toBe('url_hint');
  });
  it('validates calendar dates and refuses conflicting publisher metadata', () => {
    expect(extractPageEvidence('<meta property="article:published_time" content="2026-02-31">', 'https://example.com/story').publication.basis).toBe('unknown');
    expect(extractPageEvidence('<meta property="article:published_time" content="2026-09-09"><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2024-01-01"}</script>', 'https://example.com/story').publication.basis).toBe('unknown');
  });
  it('reads a matching Article in a JSON-LD graph, not any date in the graph', () => {
    const page = extractPageEvidence('<script type="application/ld+json">{"@graph":[{"@type":"Organization","datePublished":"2020-01-01"},{"@type":"TechArticle","url":"https://example.com/agent","datePublished":"2026-09-09"}]}</script>', 'https://example.com/agent');
    expect(page.publication).toMatchObject({ date: '2026-09-09', basis: 'publication_metadata' });
  });
  const aliasBody = 'A payment provider describes a limited pilot for agents making purchases with explicit user authorization. '
    + 'The page says the pilot is not generally available and has not independently demonstrated adoption or transaction volume.';
  const aliasArticle = { '@type': 'NewsArticle', url: 'https://publisher.example/content/site/en/news/agent-release.html',
    headline: 'A controlled payment agent pilot | Publisher', articleBody: aliasBody, datePublished: '2025-04-30T18:00:00' };
  const aliasHtml = (article: unknown = aliasArticle, body = aliasBody, extra = '') =>
    `<h1>A controlled payment agent pilot</h1><article><p>${body}</p></article><script type="application/ld+json">${JSON.stringify(article)}</script>${extra}`;

  it('recognizes a single same-origin CMS alias only with the matching headline and visible body', () => {
    const page = extractPageEvidence(aliasHtml(), 'https://publisher.example/news/agent-release.html');
    expect(page.publication).toEqual({ basis: 'publication_metadata', date: '2025-04-30', raw: aliasArticle.datePublished,
      metadataMatch: { method: 'content_alias', url: aliasArticle.url } });
  });
  it('does not accept an alias based on its title or URL alone, or match body text inside metadata itself', () => {
    expect(extractPageEvidence(aliasHtml(aliasArticle, 'An unrelated article.'), 'https://publisher.example/news/agent-release.html').publication.basis).toBe('unknown');
    expect(extractPageEvidence(aliasHtml({ ...aliasArticle, headline: 'Another payment release' }), 'https://publisher.example/news/agent-release.html').publication.basis).toBe('unknown');
    expect(extractPageEvidence(aliasHtml({ ...aliasArticle, articleBody: 'A short boilerplate.' }, 'A short boilerplate.'), 'https://publisher.example/news/agent-release.html').publication.basis).toBe('unknown');
  });
  it.each([
    'https://other.example/content/site/en/news/agent-release.html',
    'https://publisher.example/content/site/en/news/another.html',
    'https://publisher.example/content/site/en/news/agent-release.html?edition=previous',
  ])('rejects dates from unrelated or cross-origin alias metadata: %s', url => {
    expect(extractPageEvidence(aliasHtml({ ...aliasArticle, url }), 'https://publisher.example/news/agent-release.html').publication.basis).toBe('unknown');
  });
  it('refuses ambiguous or conflicting alias publication dates and still labels old material as old', () => {
    const url = 'https://publisher.example/news/agent-release.html';
    expect(extractPageEvidence(aliasHtml([aliasArticle, { ...aliasArticle, datePublished: '2026-09-11' }]), url).publication.basis).toBe('unknown');
    expect(extractPageEvidence(aliasHtml(aliasArticle, aliasBody, '<meta property="article:published_time" content="2026-09-11">'), url).publication.basis).toBe('unknown');
    const source = makeResearchSource({ url, title: 'Agent pilot', query: 'payment agent', retrievedAt: '2026-09-11',
      readable: true, relevant: true, excerpt: aliasBody, publication: extractPageEvidence(aliasHtml(), url).publication });
    expect(assessResearchSources([source], '2026-09-11', true).datedSourceCount).toBe(0);
  });
  it('does not identify lookalikes or navigation sites as the original publisher', () => {
    expect(publisherKind('https://openai.com/index/agent')).toBe('primary');
    expect(publisherKind('https://qianwen.aigc.cn/')).toBe('unverified');
    expect(publisherKind('https://openai.com.attacker.example/')).toBe('unverified');
  });
  it('requires readable relevant recent publication evidence for recent claims', () => {
    const source = makeResearchSource({ url: 'https://openai.com/index/a', title: 'Agent', query: 'AI Agent', retrievedAt: '2026-09-11', readable: true, relevant: true, excerpt: 'AI Agent news', publication: { basis: 'publication_metadata', date: '2026-09-09' } });
    expect(assessResearchSources([source, source], '2026-09-11', true).status).toBe('insufficient_evidence');
    const other = { ...source, url: 'https://anthropic.com/news/agent' };
    expect(assessResearchSources([source, other], '2026-09-11', true).status).toBe('sufficient_evidence');
    for (const date of ['2025-09-09', '2026-09-12']) {
      expect(assessResearchSources([source, { ...other, publication: { basis: 'publication_metadata', date } }], '2026-09-11', true).status).toBe('insufficient_evidence');
    }
    expect(assessResearchSources([source, { ...other, publication: { basis: 'url_hint', date: '2026-09-09' } }], '2026-09-11', true).status).toBe('insufficient_evidence');
  });
  it.each(['调研今天的AI资讯', 'AI资讯，今天的', '今日AI新闻', "today's AI news"])('does not count yesterday as today: %s', task => {
    const sources = ['https://openai.com/index/a', 'https://anthropic.com/news/b'].map(url => makeResearchSource({
      url, title: 'AI agent release', query: task, retrievedAt: '2026-09-15', readable: true, relevant: true,
      excerpt: 'A recorded release.', publication: { basis: 'publication_metadata', date: '2026-09-14' },
    }));
    expect(assessResearchSources(sources, '2026-09-15', task)).toMatchObject({ windowStart: '2026-09-15',
      status: 'insufficient_evidence', datedSourceCount: 0, primarySourceCount: 0 });
    const current = sources.map(source => ({ ...source, publication: { basis: 'publication_metadata' as const, date: '2026-09-15' } }));
    expect(assessResearchSources(current, '2026-09-15', task)).toMatchObject({ status: 'sufficient_evidence', datedSourceCount: 2 });
    expect(assessResearchSources(sources, '2026-09-15', task).issues.join()).not.toContain('近 30 天');
  });
  it.each(['今天帮我调研近30天AI进展', '截至今天的AI最新进展', 'AI news as of today'])('does not narrow a rolling/as-of request to a single day: %s', task => {
    expect(assessResearchSources([], '2026-09-15', task).windowStart).toBe('2026-08-16');
  });
  it.each([
    ['2026-09-14T16:00:00Z', '2026-09-15'],
    ['2026-09-14T15:59:59Z', '2026-09-14'],
    ['2026-09-15T00:30:00+09:00', '2026-09-14'],
    ['2026-09-15T00:30:00+08:00', '2026-09-15'],
    ['2026-09-14', '2026-09-14'],
    ['2026-09-14T23:30:00', '2026-09-14'],
  ])('uses Shanghai dates for explicitly zoned publication timestamps without guessing absent zones: %s', (raw, date) => {
    const page = extractPageEvidence(`<article><h1>AI Agent release</h1></article><meta property="article:published_time" content="${raw}">`, 'https://publisher.example/release');
    expect(page.publication).toMatchObject({ basis: 'publication_metadata', date, raw });
  });
});

describe('search result relevance and URLs', () => {
  it.each(['今天', '今日', 'today'])('does not require relative date wording in topical content: %s', day => {
    const query = `${day} AI Agent 新闻`;
    expect(extractTopicTerms(query)).toEqual(['ai', 'agent']);
    expect(sourceRelevance(query, 'AI agent release for office tasks')).toBe(1);
    expect(sourceRelevance(query, 'AI drawing tools')).toBeLessThan(0.6);
    expect(sourceRelevance(query, `${day} calendar dates`)).toBe(0);
  });
  it('matches Chinese geographic equivalents without dropping the original geographic subject', () => {
    const query = '给我调研国内最新ai资讯，今天的';
    expect(extractTopicTerms(query)).toEqual(['国内', 'ai']);
    for (const content of ['中国人工智能公司公布模型进展', '国产大模型公司公布产品进展', 'China AI model development', 'Chinese artificial intelligence companies', 'Chinese LLM release']) {
      expect(sourceRelevance(query, content)).toBe(1);
    }
    expect(sourceRelevance(query, '美国 AI 公司发布产品')).toBeLessThan(0.6);
    expect(sourceRelevance(query, '中国风电行业新闻')).toBeLessThan(0.6);
    expect(sourceRelevance('AI Agent 最新进展', '中国大模型发布')).toBeLessThan(0.6);
  });
  it('does not count AI author credits as an AI topic but retains genuine AI claims', () => {
    const query = '今天的国内AI资讯';
    const article = '来源：喜娜AI异动分析\n\n根据喜娜AI异动分析，国内风电铸件市场增长，公司的股价上涨。';
    expect(sourceRelevance(query, article)).toBeLessThan(0.6);
    expect(sourceRelevance(query, `${article}\n国内人工智能公司发布了新的模型。`)).toBeGreaterThanOrEqual(0.6);
    expect(sourceRelevance('AI news', 'Source: AI generated summary\nWind turbine shares rose.')).toBe(0);
    expect(sourceRelevance('AI news', 'AI models generated summaries of wind power data.')).toBe(1);
  });
  it('preserves Chinese domain concepts without turning intelligence pages into agent sources', () => {
    expect(extractTopicTerms('智能体支付 2026年 9月')).toEqual(['智能体', '支付']);
    expect(extractTopicTerms('AI智能体最新进展 2026年 9月')).toEqual(['ai', '智能体']);
    expect(extractTopicTerms('人工智能与多智能体协作')).toContain('人工智能');
    expect(extractTopicTerms('人工智能与多智能体协作')).toContain('智能体');
    expect(sourceRelevance('智能体支付', 'AI agent payments and checkout')).toBe(1);
    expect(sourceRelevance('智能体支付', '智能设备支持移动支付')).toBeLessThan(0.6);
    expect(sourceRelevance('AI智能体最新进展', 'AI drawing generators')).toBeLessThan(0.6);
    expect(sourceRelevance('智能体', 'A page about intelligence and smart devices')).toBe(0);
    expect(buildTopicSearchQuery('智能体支付现状', new Date('2026-09-11T00:00:00Z'))).toBe('agentic payments news September 2026');
  });
  it('keeps the subject before the date in fallback queries without broadening explicit search operators', () => {
    const date = new Date('2026-09-11T00:00:00Z');
    expect(buildTopicSearchQuery('近 30 天 AI Agent 最新进展 2026年 9月', date)).toBe('ai agent news September 2026');
    expect(buildTopicSearchQuery('支付 agent 现状', date)).toBe('agentic payments news September 2026');
    expect(buildTopicSearchQuery('site:openai.com agent latest', date)).toBe('site:openai.com agent latest');
    expect(buildTopicSearchQuery('AI Agent 最新 2026-09-15', date)).toBe('ai agent news 2026-09-15');
    for (const query of ['AI Agent 2026-02-30', 'AI Agent 2026-09-14 至 2026-09-15', '"AI Agent" 2026-09-15', 'site:openai.com AI Agent 2026-09-15']) {
      expect(buildTopicSearchQuery(query, date)).toBe(query);
    }
  });
  it('filters dates, calendar pages, RV forums and generic AI noise from Agent research', () => {
    const query = '近 30 天 AI Agent 最新进展 2026年9月';
    expect(sourceRelevance(query, '2026 calendar September 30 day')).toBe(0);
    expect(sourceRelevance(query, 'RV tire discussion 2026')).toBe(0);
    expect(sourceRelevance(query, 'AI directory: drawing generators')).toBeLessThan(0.6);
    expect(sourceRelevance(query, 'AI agent release for office tasks')).toBeGreaterThanOrEqual(0.6);
    expect(sourceRelevance('支付 agent 现状', 'Agent payments and checkout')).toBeGreaterThanOrEqual(0.6);
  });
  it('decodes Bing redirects and rejects non-web URLs', () => {
    const target = 'https://example.com/agent?utm_source=bing';
    const url = `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}`;
    expect(normalizeSourceUrl(url)).toBe('https://example.com/agent');
    expect(normalizeSourceUrl('javascript:alert(1)')).toBe('');
    const hits = parseBingResults(`<li data-test="x" class="b_algo other"><h2><a class="link" href="${url}">AI &amp; Agent</a></h2><div class="b_caption"><p>Agent release 2026</p></div></li>`);
    expect(hits).toMatchObject([{ title: 'AI & Agent', url: 'https://example.com/agent' }]);
  });
  it('preserves version and ref parameters rather than assuming every ref is a tracking alias', () => {
    expect(normalizeSourceUrl('https://example.com/report?ref=2025&version=1&utm_source=search#summary'))
      .toBe('https://example.com/report?ref=2025&version=1');
    const output = ['2025', '2026'].map(ref => `### AI Agent report\n- URL: https://example.com/report?ref=${ref}\n- AI Agent release`).join('\n');
    expect(rankSearchOutputs('AI Agent', [{ source: 'fixture', markdown: output }], 2).map(hit => hit.url))
      .toEqual(['https://example.com/report?ref=2025', 'https://example.com/report?ref=2026']);
  });
  it('reads news article links without turning relative search times into publication evidence', () => {
    const hits = parseBingNewsResults('<div><div><span aria-label="2 days ago">2 days</span><a class="title" data-author="Publisher" href="https://publisher.example/agent"><h2>AI agents for office work</h2></a></div><div class="snippet">New AI agent release.</div></div><a class="title" href="/wallpaper">Wallpaper</a>');
    expect(hits).toEqual([{ title: 'AI agents for office work', url: 'https://publisher.example/agent', snippet: 'New AI agent release.', source: 'Bing News' }]);
    expect(JSON.stringify(hits)).not.toContain('days');
  });
  it('deduplicates providers and enforces maxResults after ranking', () => {
    const markdown = '### Calendar 2026\n- URL: https://calendar.example/\n- Dates\n### AI Agent release\n- URL: https://example.com/agent\n- New AI agent release\n### AI Agent homepage\n- URL: https://example.com/\n- AI agents';
    const hits = rankSearchOutputs('AI Agent latest news', [{ source: 'Bing', markdown }, { source: 'Other', markdown }], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://example.com/agent');
  });
});
