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

const WC_REGIONS = [
  {name:'동아시아',   source:'South China Morning Post', feed:'https://www.scmp.com/rss/91/feed', lang:'en'},
  {name:'중앙아시아', source:'Eurasianet',                feed:'https://eurasianet.org/rss', lang:'en'},
  {name:'남아시아',   source:'The Hindu',                 feed:'https://www.thehindu.com/news/international/feeder/default.rss', lang:'en'},
  {name:'동남아시아', source:'Bangkok Post',              feed:'https://www.bangkokpost.com/rss/data/topstories.xml', lang:'en'},
  {name:'중동',       source:'Al Jazeera',                feed:'https://www.aljazeera.com/xml/rss/all.xml', lang:'en'},
  {name:'아프리카',   source:'AllAfrica',                 feed:'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf', lang:'en'},
  {name:'유럽',       source:'Euronews',                  feed:'https://www.euronews.com/rss?level=theme&name=news', lang:'en'},
  {name:'아메리카',   source:'Global Voices',             feed:'https://globalvoices.org/-/world/americas/feed/', lang:'en'},
  {name:'한국',       source:'연합뉴스',                  feed:'https://www.yna.co.kr/rss/news.xml', lang:'ko'},
  {name:'미국',       source:'The New York Times',        feed:'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', lang:'en'},
  {name:'일본',       source:'NHK뉴스',                   feed:'https://www3.nhk.or.jp/rss/news/cat0.xml', lang:'ja'},
];
function wcGoogleFeedUrl(topic) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(topic) + '&hl=en-US&gl=US&ceid=US:en';
}
const WC_STOPWORDS = {
  the:1, a:1, an:1, of:1, to:1, in:1, on:1, for:1, and:1, or:1, is:1, are:1, was:1, were:1,
  with:1, at:1, by:1, from:1, as:1, it:1, its:1, this:1, that:1, be:1, has:1, have:1, will:1, not:1,
  '이':1, '그':1, '저':1, '것':1, '수':1, '등':1, '및':1, '을':1, '를':1, '은':1, '는':1, '에':1, '의':1,
  '가':1, '과':1, '와':1, '도':1, '로':1, '으로':1, '에서':1,
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
  const haySet = new Set(wcTokenize(item.title + ' ' + (item.description || '')));
  return keywords.filter((k) => haySet.has(k)).length;
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
    }));
  } catch {
    return [];
  }
}
async function wcFetchRegion(feedUrl, keywords) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(feedUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisualMagazineBot/1.0)' } });
    const text = await r.text();
    const items = wcParseXml(text);
    const minScore = keywords.length >= 3 ? 2 : 1;
    let best = null, bestScore = 0;
    for (const item of items) {
      const s = wcScore(item, keywords);
      if (s > bestScore) { bestScore = s; best = item; }
    }
    return { item: best, matched: bestScore >= minScore };
  } catch {
    return { item: null, matched: false };
  } finally {
    clearTimeout(timer);
  }
}
async function refreshCoverageForPost(supabase, post) {
  const topic = post.title || '';
  if (wcTokenize(topic).length === 0) return;
  const regions = WC_REGIONS.concat([{ name: '구글 뉴스', source: 'Google News', feed: wcGoogleFeedUrl(topic), lang: 'en' }]);
  const langs = [...new Set(regions.map((r) => r.lang))];
  const keywordsByLang = {};
  for (const lang of langs) {
    const translated = await wcTranslate(topic, lang);
    keywordsByLang[lang] = wcTokenize(translated);
  }
  const results = await Promise.all(regions.map(async (region) => {
    const { item, matched } = await wcFetchRegion(region.feed, keywordsByLang[region.lang] || wcTokenize(topic));
    return {
      post_id: post.id, region: region.name, source: region.source,
      matched, item_title: item?.title || null, item_link: item?.link || null,
      updated_at: new Date().toISOString(),
    };
  }));
  await supabase.from('world_coverage_cache').upsert(results, { onConflict: 'post_id,region' });
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
