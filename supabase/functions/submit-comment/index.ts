// 댓글 작성 / 좋아요 증가를 처리하는 Edge Function.
// 클라이언트가 IP/국가/VPN 여부를 직접 보낼 수 없게, 이 함수가 실제 요청 IP를 보고
// 무료 공개 데이터셋으로 VPN 여부와 국가를 판별한 뒤 service_role 키로 DB에 씀
// (comments 테이블은 anon/authenticated에 insert 정책이 없어서 여기서만 쓸 수 있음).
//
// 데이터 출처 (둘 다 무료, API 키/쿼터 없음, 콜드스타트마다 다시 받아서 메모리 캐시):
//   VPN 대역:   https://github.com/X4BNet/lists_vpn (MIT)
//   IP-국가 대역: https://github.com/sapics/ip-location-db (PDDL, public domain)

import { createClient } from 'npm:@supabase/supabase-js@2';

const VPN_LIST_URL = 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt';
const COUNTRY_IPV4_URL = 'https://github.com/sapics/ip-location-db/releases/download/latest/user-country-ipv4.csv';
const COUNTRY_IPV6_URL = 'https://github.com/sapics/ip-location-db/releases/download/latest/user-country-ipv6.csv';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// module-scope cache: lives as long as this function instance stays warm
let vpnRanges = null; // sorted [startInt, endInt][]
let countryRangesV4 = null; // sorted [startInt, endInt, code][]
let countryRangesV6 = null; // sorted [startBig, endBig, code][] (BigInt)
let loadingPromise = null;

function parseCidrLine(line) {
  const [ip, bitsStr] = line.trim().split('/');
  const start = ipv4ToInt(ip);
  if (start === null) return null;
  const bits = Number(bitsStr);
  const size = bits >= 32 ? 0 : (2 ** (32 - bits)) - 1;
  return [start >>> 0, (start + size) >>> 0];
}

async function loadDatasets() {
  if (vpnRanges && countryRangesV4) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const [vpnText, countryV4Text] = await Promise.all([
      fetch(VPN_LIST_URL).then((r) => r.text()),
      fetch(COUNTRY_IPV4_URL).then((r) => r.text()),
    ]);
    vpnRanges = vpnText.split('\n').map(parseCidrLine).filter(Boolean).sort((a, b) => a[0] - b[0]);
    countryRangesV4 = countryV4Text.split('\n').filter(Boolean).map((line) => {
      const [start, end, code] = line.split(',');
      const s = ipv4ToInt(start), e = ipv4ToInt(end);
      return s === null ? null : [s, e, code];
    }).filter(Boolean).sort((a, b) => a[0] - b[0]);
    // ipv6 country db is fetched lazily on first ipv6 request, not on every cold start
  })();
  await loadingPromise;
  loadingPromise = null;
}

function binarySearchRange(ranges, value) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (value < start) hi = mid - 1;
    else if (value > end) lo = mid + 1;
    else return ranges[mid];
  }
  return null;
}

async function lookupIpv6Country(ip) {
  if (!countryRangesV6) {
    const text = await fetch(COUNTRY_IPV6_URL).then((r) => r.text());
    countryRangesV6 = text.split('\n').filter(Boolean).map((line) => {
      const [start, end, code] = line.split(',');
      try { return [ipv6ToBig(start), ipv6ToBig(end), code]; } catch { return null; }
    }).filter(Boolean).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  const value = ipv6ToBig(ip);
  let lo = 0, hi = countryRangesV6.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end, code] = countryRangesV6[mid];
    if (value < start) hi = mid - 1;
    else if (value > end) lo = mid + 1;
    else return code;
  }
  return null;
}

function ipv6ToBig(ip) {
  const parts = ip.split('::');
  let head = parts[0] ? parts[0].split(':') : [];
  let tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  if (parts.length > 1) {
    const missing = 8 - head.length - tail.length;
    head = head.concat(Array(missing).fill('0'));
  }
  const groups = head.concat(tail).map((h) => h ? parseInt(h, 16) : 0);
  let big = 0n;
  for (const g of groups) big = (big << 16n) + BigInt(g);
  return big;
}

function detectIp(req) {
  // cf-connecting-ip is set by Cloudflare itself, not client-controllable - most trustworthy.
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  // x-forwarded-for can be spoofed by the client (they prepend a fake value), but Supabase's
  // gateway always APPENDS the real observed IP as the last entry - so take the last one, not the first.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get('x-real-ip') || '';
}

async function classifyIp(ip) {
  if (ip.includes(':')) {
    const country = await lookupIpv6Country(ip).catch(() => null);
    return { prefix: null, country, isVpn: false }; // no free IPv6 VPN dataset available
  }
  const value = ipv4ToInt(ip);
  if (value === null) return { prefix: null, country: null, isVpn: false };
  const isVpn = !!binarySearchRange(vpnRanges, value);
  const match = binarySearchRange(countryRangesV4, value);
  const parts = ip.split('.');
  return { prefix: parts[0] + '.' + parts[1], country: match ? match[2] : null, isVpn };
}

// '엇갈린 시선/놓친 이야기'가 쓰는 RSS 소스 도메인만 허용 (오픈 프록시로 악용되는 것 방지)
const RSS_HOST_ALLOWLIST = [
  'scmp.com', 'eurasianet.org', 'thehindu.com', 'bangkokpost.com', 'aljazeera.com',
  'allafrica.com', 'euronews.com', 'globalvoices.org', 'yna.co.kr', 'nytimes.com',
  'nhk.or.jp', 'news.google.com',
];
function isAllowedRssUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname;
    return RSS_HOST_ALLOWLIST.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/* ---- world coverage precompute: runs on a schedule (not per-visitor), caches results
   in world_coverage_cache so post.html just reads instantly instead of live-fetching. ---- */
import { XMLParser } from 'npm:fast-xml-parser@4';
const xmlParser = new XMLParser({ ignoreAttributes: false });

// 예전엔 지역마다 언론사 1곳을 정해두고 그 RSS 최신 목록에 이 주제가 "있냐 없냐"만 봤는데,
// 그건 그 언론사가 실제로 다뤘어도 오늘자 RSS에 없으면 그냥 "미보도"로 잘못 뜨는 문제가 있었음.
// 그래서 지역별 고정 피드 대신, 여러 언어권에서 이 주제를 실제로 검색해 찾은 기사들을 모으는 방식으로 바꿈 -
// "보도했나 안했나"가 아니라 "다룬 곳들이 각각 뭘 강조했나"를 보여주는 게 목적이라, 검색으로 실제
// 기사를 찾아야 각 언론사의 진짜 관점(claims)을 비교할 재료가 생김.
const WC_MARKETS = [
  { label:'한국',      hl:'ko',    gl:'KR', ceid:'KR:ko',       lang:'ko' },
  { label:'미국',      hl:'en-US', gl:'US', ceid:'US:en',       lang:'en' },
  { label:'영국',      hl:'en-GB', gl:'GB', ceid:'GB:en',       lang:'en' },
  { label:'일본',      hl:'ja',    gl:'JP', ceid:'JP:ja',       lang:'ja' },
  { label:'중화권',    hl:'zh-TW', gl:'TW', ceid:'TW:zh-Hant',  lang:'zh' },
  { label:'유럽(불어권)', hl:'fr', gl:'FR', ceid:'FR:fr',       lang:'fr' },
  { label:'중남미',    hl:'es-419',gl:'MX', ceid:'MX:es-419',   lang:'es' },
  { label:'중동',      hl:'ar',    gl:'EG', ceid:'EG:ar',       lang:'ar' },
  { label:'인도',      hl:'hi',    gl:'IN', ceid:'IN:hi',       lang:'hi' },
];
function wcGoogleFeedUrl(topic, market) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(topic) +
    '&hl=' + market.hl + '&gl=' + market.gl + '&ceid=' + market.ceid;
}
const WC_STOPWORDS = {
  the:1, a:1, an:1, of:1, to:1, in:1, on:1, for:1, and:1, or:1, is:1, are:1, was:1, were:1,
  with:1, at:1, by:1, from:1, as:1, it:1, its:1, this:1, that:1, be:1, has:1, have:1, will:1, not:1,
  '이':1, '그':1, '저':1, '것':1, '수':1, '등':1, '및':1, '을':1, '를':1, '은':1, '는':1, '에':1, '의':1,
  '가':1, '과':1, '와':1, '도':1, '로':1, '으로':1, '에서':1,
  // 흔한 직함/역할 단어는 그 자체로는 이 사건 특정적이지 않아서, 단독 매칭 시 무관한 기사와
  // 잘못 매칭되기 쉬움 (예: "ambassador"가 들어간 전혀 다른 외교 기사) - 걸러내서 이름/고유명사
  // 같은 진짜 특정적인 단어로만 매칭되게 함
  ambassador:1, minister:1, president:1, chairman:1, chairwoman:1, ceo:1, chief:1,
  spokesperson:1, spokesman:1, official:1, envoy:1, secretary:1, director:1, governor:1,
  senator:1, congressman:1, congresswoman:1, representative:1, delegate:1, prime:1,
};
function wcTokenize(text) {
  return (text || '').toLowerCase()
    .split(/[\s,."'?!:;()\[\]〈〉《》·\-–—]+/)
    .filter((w) => {
      // CJK words are meaningfully short (names, places are often 2 chars) - the
      // length>=3 rule only makes sense for filtering short English function words.
      const minLen = /[가-힣ぁ-んァ-ヶ一-龯]/.test(w) ? 2 : 3;
      return w.length >= minLen && !WC_STOPWORDS[w];
    });
}
function wcScore(item, keywords) {
  // substring containment, not exact-token equality: catches compound words, inflected
  // forms, and different word-boundary choices (e.g. "주한미국대사" vs "주한 미국대사")
  // that would otherwise never line up as identical tokens across different outlets.
  const hay = (item.title + ' ' + (item.description || '')).toLowerCase();
  return keywords.filter((k) => hay.includes(k)).length;
}
function wcDetectLang(text) { return /[가-힣]/.test(text) ? 'ko' : 'en'; }
async function wcTranslate(text, targetLang) {
  const srcLang = wcDetectLang(text);
  if (srcLang === targetLang) return text;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + srcLang + '|' + targetLang, { signal: ctrl.signal });
    const data = await r.json();
    return data?.responseData?.translatedText || text;
  } catch {
    return text;
  } finally {
    clearTimeout(timer);
  }
}
function wcParseXml(xmlText) {
  try {
    const doc = xmlParser.parse(xmlText);
    let items = doc.rss?.channel?.item || doc.feed?.entry || [];
    if (!Array.isArray(items)) items = [items].filter(Boolean);
    return items.map((it) => ({
      title: String(it.title ?? '').trim(),
      link: typeof it.link === 'string' ? it.link : (it.link?.['@_href'] || ''),
      description: String(it.description ?? it.summary ?? '').trim(),
      // 구글 뉴스처럼 여러 언론사를 한 피드로 묶어 보여주는 소스는 <source> 태그에 실제 언론사명이 들어있음
      source: typeof it.source === 'string' ? it.source : (it.source?.['#text'] || ''),
    }));
  } catch {
    return [];
  }
}
function wcStripSourceSuffix(title, source) {
  // 구글 뉴스 제목은 관례적으로 끝에 " - 언론사명"이 붙는데, source를 따로 보여줄 거라 중복이라 제거
  if (!source) return title;
  const suffix = ' - ' + source;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}
async function verifySameTopic(topic, candidateTitle) {
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (!groqKey) return true; // no key configured yet - fall back to keyword-only matching
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content:
          '다음 두 제목이 같은 구체적인 사건을 다루고 있는지 확인하세요. 단어가 겹쳐도 동명이인·동음이의어 때문에 ' +
          '전혀 다른 사건일 수 있습니다 (예: 사람 이름과 회사 이름이 같은 경우).\n' +
          '기준: ' + topic + '\n비교 대상: ' + candidateTitle + '\n\n' +
          '같은 사건이면 yes, 다른 사건이면 no 라고만 답하세요.' }],
        temperature: 0,
        max_tokens: 5,
      }),
    });
    const data = await r.json();
    const answer = (data.choices?.[0]?.message?.content || '').toLowerCase();
    return answer.includes('yes');
  } catch {
    return true; // Groq failure shouldn't break matching entirely - fail open to keyword result
  }
}
async function wcExtractTopic(title) {
  // 제목이 "13만명이 출근을 못해...2차대전 이후 최악"처럼 낚시성/수사적 표현이면 그걸 그대로
  // 번역해서 검색해봤자 외국 매체 검색어로는 안 맞음 - 검색에 쓸 핵심 사건만 짧게 뽑아둠
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (!groqKey) return title;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content:
          '다음 기사 제목에서 낚시성 표현이나 수사적 질문은 빼고, 뉴스 검색에 바로 쓸 수 있는 핵심 사건만 ' +
          '짧은 구절(5단어 이내)로 뽑으세요. 다른 설명 없이 검색어만 답하세요.\n\n제목: ' + title }],
        temperature: 0,
        max_tokens: 30,
      }),
    });
    const data = await r.json();
    const extracted = (data.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    return extracted || title;
  } catch {
    return title;
  }
}
async function wcFetchMarket(searchQuery, verifyTitle, market, keywords) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(wcGoogleFeedUrl(searchQuery, market), { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisualMagazineBot/1.0)' } });
    const text = await r.text();
    const items = wcParseXml(text);
    const minScore = 1; // any one distinctive keyword hit counts as coverage
    // 한 시장에서 여러 언론사가 각자 다뤘을 수 있으니 1등만 뽑지 않고 점수순 상위 몇 개를 후보로 둠
    const candidates = items
      .map((it) => ({ item: it, score: wcScore(it, keywords) }))
      .filter((c) => c.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    const verified = [];
    for (const c of candidates) {
      // keyword overlap alone can't tell "Michelle Steel" from "British Steel" - a name/word can
      // mean two unrelated things, so double check with the LLM before calling it a real match.
      // 원래 기사 제목(맥락이 더 풍부함)을 기준으로 같은 사건인지 판단함
      if (await verifySameTopic(verifyTitle, c.item.title)) verified.push(c.item);
      if (verified.length >= 2) break; // 한 시장당 최대 2곳까지만, LLM 호출량을 적당히 묶어둠
    }
    return verified;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
async function refreshCoverageForPost(supabase, post) {
  const rawTitle = post.title || '';
  if (wcTokenize(rawTitle).length === 0) return;
  const topic = await wcExtractTopic(rawTitle);
  const langs = [...new Set(WC_MARKETS.map((m) => m.lang))];
  const keywordsByLang = {};
  for (const lang of langs) {
    const translated = await wcTranslate(topic, lang);
    keywordsByLang[lang] = wcTokenize(translated);
  }
  const perMarket = await Promise.all(WC_MARKETS.map(async (market) => {
    const items = await wcFetchMarket(topic, rawTitle, market, keywordsByLang[market.lang] || wcTokenize(topic));
    return items.map((item) => ({ item, market }));
  }));
  const found = perMarket.flat();

  // 같은 기사가 여러 언어권 검색에 동시에 걸릴 수 있어서(예: 영국·미국 검색 둘 다 같은 로이터 기사),
  // 언론사명+제목 기준으로 중복 제거
  const seen = new Set();
  const deduped = found.filter(({ item }) => {
    const key = (item.source || '') + '|' + item.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 새로고침마다 지우고 다시 쓰면, 검색 결과가 실행마다 달라질 수 있어서(구글 뉴스 검색은 매번 똑같지 않음)
  // 이전에 찾아둔 매체가 그냥 사라져버림 - 기존 것은 남겨두고 이번에 새로 찾은 것만 더함
  const { data: existingRows } = await supabase.from('world_coverage_cache').select('source,item_title').eq('post_id', post.id);
  const dedupeKey = (source, title) => (source || '').toLowerCase() + '|' + (title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const alreadyStored = new Set((existingRows || []).map((r) => dedupeKey(r.source, r.item_title)));

  const newRows = [];
  for (const { item, market } of deduped) {
    const cleanTitle = wcStripSourceSuffix(item.title, item.source);
    const source = item.source || market.label;
    if (alreadyStored.has(dedupeKey(source, cleanTitle))) continue;
    // 한국어 화면에 보여줄 거라 원문이 외국어면 한국어로 번역해서 저장 (원문은 링크로 확인 가능)
    const displayTitle = market.lang !== 'ko' ? await wcTranslate(cleanTitle, 'ko') : cleanTitle;
    newRows.push({
      post_id: post.id, region: market.label, source,
      matched: true, item_title: displayTitle || null, item_link: item.link || null,
      updated_at: new Date().toISOString(),
    });
  }

  if (newRows.length) await supabase.from('world_coverage_cache').insert(newRows);
  const { data: allRows } = await supabase.from('world_coverage_cache').select('source,item_title').eq('post_id', post.id);
  await refreshClaimsForPost(supabase, post, allRows || []);
}

/* ---- claim-level "who skipped what": which outlets share the same specific angle,
   using a free-tier open-source model (Llama 3.3 via Groq) instead of a paid API. ---- */
async function extractClaims(matchedResults) {
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (!groqKey || matchedResults.length < 2) return [];
  const listing = matchedResults.map((r) => `[${r.source}] ${r.item_title}`).join('\n');
  const prompt =
    '다음은 같은 사건을 다룬 여러 언론사의 기사 제목입니다.\n\n' + listing +
    '\n\n이 제목들에서 서로 다른 핵심 주장이나 초점을 3~5개 뽑고, 각각을 어느 언론사([...] 안의 이름)가 다뤘는지 표시하세요. ' +
    '반드시 다음 JSON 형식으로만 답하세요: {"claims":[{"claim":"한 문장 요약","outlets":["언론사명", ...]}]}';
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    const data = await r.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return Array.isArray(parsed.claims) ? parsed.claims : [];
  } catch {
    return [];
  }
}
async function refreshClaimsForPost(supabase, post, matchedResults) {
  await supabase.from('world_coverage_claims').delete().eq('post_id', post.id);
  const claims = await extractClaims(matchedResults);
  if (claims.length === 0) return;
  const allSources = matchedResults.map((r) => r.source);
  const rows = claims.map((c) => {
    const covered = (c.outlets || []).filter((o) => allSources.includes(o));
    return {
      post_id: post.id, claim: c.claim,
      outlets_covered: covered, outlets_missed: allSources.filter((s) => !covered.includes(s)),
      updated_at: new Date().toISOString(),
    };
  });
  await supabase.from('world_coverage_claims').insert(rows);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const body = await req.json();

    // RSS 프록시: VPN/국가 판별이 필요 없는 단순 읽기 전용 요청이라 먼저 처리
    if (body.action === 'fetch-rss') {
      const feedUrl = String(body.url || '');
      if (!isAllowedRssUrl(feedUrl)) throw new Error('허용되지 않은 URL이에요.');
      const r = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisualMagazineBot/1.0)' } });
      const text = await r.text();
      return new Response(text, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // 스케줄러(cron)가 주기적으로 호출 - 방문자 요청이 아니라 VPN/국가 판별은 필요 없음
    if (body.action === 'refresh-coverage') {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const { data: posts, error: postsError } = await supabaseAdmin.from('posts').select('id,title');
      if (postsError) throw postsError;
      for (const post of posts || []) {
        await refreshCoverageForPost(supabaseAdmin, post);
      }
      return new Response(JSON.stringify({ ok: true, refreshed: (posts || []).length }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const ip = detectIp(req);
    await loadDatasets();
    const { isVpn, prefix, country } = await classifyIp(ip);

    if (isVpn) {
      return new Response(JSON.stringify({ error: 'VPN/프록시 사용 중에는 댓글·좋아요를 이용할 수 없어요.' }), {
        status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    );

    if (body.action === 'like') {
      const postId = Number(body.post_id);
      if (!postId) throw new Error('post_id가 필요해요.');
      const { error } = await supabase.rpc('increment_likes', { post_id: postId });
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'comment') {
      const postId = Number(body.post_id);
      const nickname = String(body.nickname || '').trim().slice(0, 20);
      const avatarSeed = String(body.avatar_seed || '').trim().slice(0, 40);
      const text = String(body.body || '').trim().slice(0, 100);
      if (!postId || !nickname || !text) throw new Error('입력값이 비어있어요.');

      // 도배 방지: 같은 IP는 짧은 시간 안에 연속으로 못 올림
      const RATE_LIMIT_SECONDS = 15;
      const { data: rl } = await supabase.from('comment_rate_limit').select('last_at').eq('ip', ip).maybeSingle();
      if (rl && Date.now() - new Date(rl.last_at).getTime() < RATE_LIMIT_SECONDS * 1000) {
        return new Response(JSON.stringify({ error: '너무 빠르게 연속 작성했어요. 잠시 후 다시 시도해주세요.' }), {
          status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await supabase.from('comment_rate_limit').upsert({ ip, last_at: new Date().toISOString() });

      // 닉네임이 이 글에서 이미 쓰였으면 뒤에 숫자를 붙여 구분 (다정한다람쥐 -> 다정한다람쥐2)
      const { data: existingRows } = await supabase.from('comments').select('nickname').eq('post_id', postId);
      const existingNames = new Set((existingRows || []).map((r) => r.nickname));
      let finalNickname = nickname;
      if (existingNames.has(finalNickname)) {
        let n = 2;
        while (existingNames.has(nickname + n)) n++;
        finalNickname = nickname + n;
      }

      const { data, error } = await supabase.from('comments').insert({
        post_id: postId, nickname: finalNickname, avatar_seed: avatarSeed, body: text,
        ip_prefix: prefix, country,
      }).select().single();
      if (error) throw error;
      return new Response(JSON.stringify({ data }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    throw new Error('알 수 없는 action이에요.');
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
