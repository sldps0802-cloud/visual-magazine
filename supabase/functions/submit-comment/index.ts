// 댓글 작성 / 좋아요 증가를 처리하는 Edge Function.
// 클라이언트가 IP/국가/VPN 여부를 직접 보낼 수 없게, 이 함수가 실제 요청 IP를 보고
// 무료 공개 데이터셋으로 VPN 여부와 국가를 판별한 뒤 service_role 키로 DB에 씀
// (comments 테이블은 anon/authenticated에 insert 정책이 없어서 여기서만 쓸 수 있음).
//
// 데이터 출처 (다 무료, API 키/쿼터 없음, 콜드스타트마다 다시 받아서 메모리 캐시):
//   VPN 대역(IPv4 전용):     https://github.com/X4BNet/lists_vpn (MIT)
//   IP-국가 대역:            https://github.com/sapics/ip-location-db user-country (PDDL, public domain)
//   서버/호스팅(데이터센터) 대역: https://github.com/sapics/ip-location-db server-country (PDDL) -
//     X4BNet 리스트엔 IPv6가 아예 없어서(IPv6로 접속하면 VPN 체크가 통째로 빠짐) 이걸로 메꿈.
//     "server-country"는 사람이 쓰는 회선(user-country)이 아니라 데이터센터/호스팅 IP만 모아둔
//     대역이라, VPN·프록시 서비스 대부분이 여기 걸림 - IPv4/IPv6 둘 다 있어서 IPv6 구멍도 막힘.

import { createClient } from 'npm:@supabase/supabase-js@2';

const VPN_LIST_URL = 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt';
const COUNTRY_IPV4_URL = 'https://github.com/sapics/ip-location-db/releases/download/latest/user-country-ipv4.csv';
const COUNTRY_IPV6_URL = 'https://github.com/sapics/ip-location-db/releases/download/latest/user-country-ipv6.csv';
const SERVER_IPV6_URL = 'https://github.com/sapics/ip-location-db/releases/download/latest/server-country-ipv6.csv';

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
let serverRangesV6 = null; // sorted [startBig, endBig, code][] (BigInt) - datacenter/hosting IPv6 (VPN/proxy signal)
let loadingPromise = null;

function parseCidrLine(line) {
  const [ip, bitsStr] = line.trim().split('/');
  const start = ipv4ToInt(ip);
  if (start === null) return null;
  const bits = Number(bitsStr);
  const size = bits >= 32 ? 0 : (2 ** (32 - bits)) - 1;
  return [start >>> 0, (start + size) >>> 0];
}

function parseIpv4RangeCsv(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [start, end, code] = line.split(',');
    const s = ipv4ToInt(start), e = ipv4ToInt(end);
    return s === null ? null : [s, e, code];
  }).filter(Boolean).sort((a, b) => a[0] - b[0]);
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
    countryRangesV4 = parseIpv4RangeCsv(countryV4Text);
    // ipv6 dbs are fetched lazily on first ipv6 request, not on every cold start
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

async function loadIpv6Ranges(url) {
  const text = await fetch(url).then((r) => r.text());
  return text.split('\n').filter(Boolean).map((line) => {
    const [start, end, code] = line.split(',');
    try { return [ipv6ToBig(start), ipv6ToBig(end), code]; } catch { return null; }
  }).filter(Boolean).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function searchIpv6Ranges(ranges, ip) {
  const value = ipv6ToBig(ip);
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end, code] = ranges[mid];
    if (value < start) hi = mid - 1;
    else if (value > end) lo = mid + 1;
    else return code;
  }
  return null;
}

async function lookupIpv6Country(ip) {
  if (!countryRangesV6) countryRangesV6 = await loadIpv6Ranges(COUNTRY_IPV6_URL);
  return searchIpv6Ranges(countryRangesV6, ip);
}

async function lookupIpv6Server(ip) {
  if (!serverRangesV6) serverRangesV6 = await loadIpv6Ranges(SERVER_IPV6_URL);
  return searchIpv6Ranges(serverRangesV6, ip);
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
    const [country, isServerHost] = await Promise.all([
      lookupIpv6Country(ip).catch(() => null),
      lookupIpv6Server(ip).catch(() => null),
    ]);
    // X4BNet의 VPN 리스트는 IPv4만 있어서, IPv6로 접속하면 예전엔 isVpn이 무조건 false였음(우회 가능했던 지점).
    // server-country(데이터센터/호스팅 대역)는 IPv6도 있어서 이걸로 대신 판별함.
    return { prefix: null, country, isVpn: !!isServerHost };
  }
  const value = ipv4ToInt(ip);
  if (value === null) return { prefix: null, country: null, isVpn: false };
  // IPv4는 X4BNet VPN 목록만으로 판별한다 -- server-country(데이터센터/호스팅 대역) 데이터셋도
  // 같이 썼었는데, 국가 단위로 뭉뚱그려 놓은 탓에 한국 KT 대역(14.32.0.0~14.95.255.255,
  // 순수 가정용/모바일 고객 IP도 잔뜩 포함된 구간)까지 "서버"로 오분류해서 VPN 안 쓰는
  // 실사용자를 막아버렸다(실측 확인: 14.47.94.44 -- 실제 X4BNet 목록엔 없는데
  // server-country에선 KR 서버로 잡힘). ISP 대역을 이렇게 뭉뚱그리는 데이터셋은
  // 신뢰할 수 없어서 뺐다.
  const isKnownVpn = !!binarySearchRange(vpnRanges, value);
  const match = binarySearchRange(countryRangesV4, value);
  const parts = ip.split('.');
  return { prefix: parts[0] + '.' + parts[1], country: match ? match[2] : null, isVpn: isKnownVpn };
}

/* ---- 비저너리 승률 랭킹 계산: 원래 fortune_site/index.html 클라이언트 JS에 있던 로직을
   그대로 옮김. 원본 발언 기록(visionary_calls)은 신빙성을 위해 계속 공개 조회 가능하게
   두지만(어느 발언으로 판정했는지 투명하게 보여야 랭킹을 신뢰할 수 있음), 승률·초과수익·
   표본부족 기준 같은 "계산식"은 view-source로 그대로 복사되지 않도록 서버에서 계산해서
   완성된 숫자만 내려준다. ---- */
function callExcessReturn(c) {
  if (c.price_at_call == null || c.price_at_judge == null || c.benchmark_return_pct == null) return null;
  const assetReturn = (c.price_at_judge - c.price_at_call) / c.price_at_call * 100;
  const callReturn = c.direction === 'up' ? assetReturn : -assetReturn;
  return callReturn - c.benchmark_return_pct;
}
function computeVisionaryRanking(calls) {
  const judged = calls.filter((c) => c.status === 'hit' || c.status === 'miss');
  if (judged.length === 0) return { rows: [], baseline: null };

  let baseline = null;
  const baselineSamples = judged.filter((c) => c.benchmark_return_pct != null);
  if (baselineSamples.length > 0) {
    baseline = baselineSamples.filter((c) => c.benchmark_return_pct > 0).length / baselineSamples.length * 100;
  }

  const byName = {};
  judged.forEach((c) => {
    const g = byName[c.influencer_name] || (byName[c.influencer_name] = { hit: 0, total: 0, alphaSum: 0, alphaN: 0 });
    g.total++;
    if (c.status === 'hit') g.hit++;
    const excess = callExcessReturn(c);
    if (excess !== null) { g.alphaSum += excess; g.alphaN++; }
  });

  const rows = Object.keys(byName).map((name) => {
    const g = byName[name];
    return {
      name,
      hit: g.hit,
      total: g.total,
      winRate: g.hit / g.total * 100,
      avgAlpha: g.alphaN ? g.alphaSum / g.alphaN : null,
      lowSample: g.total < 15,
    };
  }).sort((a, b) => b.winRate - a.winRate);

  return { rows, baseline };
}

/* ---- 비저너리 자동 수집·판정: 원래 vcompany7/visionary_tool.py(로컬 PC + Windows 작업
   스케줄러)로 돌던 걸 이 Edge Function으로 옮겼다 -- PC가 꺼져있으면 안 도는 문제를 없애려고.
   로컬 버전과 다른 점 세 가지(정직하게 기록):
   1. Ollama 대신 이미 있는 callLLM()(Groq/Cerebras/Gemini 무료 티어)을 쓴다.
   2. 자막(youtube_transcript_api) 기반 분류 대신 제목+설명만 본다 -- Deno에는 자막 추출
      라이브러리가 없고, 워치 페이지를 직접 파싱해서 구현하는 건 이번 포팅 범위를 넘어선다.
      필요해지면 나중에 추가할 수 있다(자막 없이도 경제 유튜브 제목은 대부분 방향이
      드러나는 편이라 품질 저하는 제한적일 것으로 예상 -- 실측은 아직 안 함).
   3. "seen" 추적을 로컬 JSON 파일 대신 video_id unique 제약으로 대신한다 -- Edge Function은
      호출마다 새 프로세스라 로컬 디스크에 상태를 못 남긴다. 부작용: "방향 발언 아님"으로
      판정된 영상은 기록이 안 남아서, RSS 최신 3개 안에 머무는 동안(새 영상이 더 올라오기
      전까지) 매 실행마다 다시 분류된다 -- 무료 티어라 비용 문제는 없고, 새 영상에 밀려나면
      자연히 멈춘다. ---- */
const VISIONARY_CHANNELS = [
  { name: '삼프로TV', channelId: 'UChlv4GSd7OQl3js-jkLOnFA' },
  { name: '슈카월드', channelId: 'UCsJ6RuBiTVWRX156FVbeaGg' },
  { name: '김단테 (내일은 투자왕)', channelId: 'UCKTMvIu9a4VGSrpWy-8bUrQ' },
  { name: '한국경제TV', channelId: 'UCF8AeLlUbEpKju6v1H6p8Eg' },
  { name: '웅달책방', channelId: 'UCbOIEn95Rvnk97KRtSFqvbQ' },
  { name: '전인구경제연구소', channelId: 'UCznImSIaxZR7fdLCICLdgaQ' },
  { name: '강환국', channelId: 'UCSWPuzlD337Y6VBkyFPwT8g' },
  { name: '소수몽키', channelId: 'UCC3yfxS5qC6PCwDzetUuEWg' },
  { name: '재테크 읽어주는 파일럿', channelId: 'UCaWi2foADm_lKAKnmeQwLSA' },
  { name: '알렉스 (알상무)', channelId: 'UC5kL3Ee6yY2bOtL2FRtdyuA' },
  { name: 'E트렌드', channelId: 'UCpsfkRRT7L2nBnizBn_u9YA' },
  { name: '미국주식 에디', channelId: 'UCMupe3fvv1-Hi3SRxZzSsTw' },
  { name: '머니코믹스 미장은지금', channelId: 'UCJo6G1u0e_-wS-JQn3T-zEw' },
  { name: '증시각도기TV', channelId: 'UCdOjVxkj5JA0iDu3_xcsTyQ' },
  { name: '존버나드', channelId: 'UCA6SixcHtinijIAC3rLc9XA' },
  { name: '오선의 미국 증시 라이브', channelId: 'UC_JJ_NhRqPKcIOj5Ko3W_3w' },
  { name: '서대리TV', channelId: 'UCtQkxwZkrruYdy2bVNNW-Rw' },
  { name: '삼쩜삼캠퍼스', channelId: 'UCamX91KxAzdicrLY6JPXjrw' },
  { name: '올랜도 킴 미국주식', channelId: 'UCwSSqi-s0wcH6pJbH3YPZqQ' },
  // 박종훈팀장(바이킹스)은 별도 채널이 아니라 위 '머니코믹스 미장은지금' 채널 안의
  // 코너라서 따로 추가하지 않음(실측 확인) -- 추가하면 같은 영상이 두 번 잡힘.
];

// market_tool.py의 WATCH/ALIAS를 그대로 축소 이식 -- 개별 종목 콜을 코스피로 뭉개지 않기 위함.
const VISIONARY_WATCH = [
  ['코스피', '^KS11'], ['코스닥', '^KQ11'],
  ['삼성전자', '005930.KS'], ['SK하이닉스', '000660.KS'],
  ['나스닥', '^IXIC'], ['S&P500', '^GSPC'],
  ['반도체ETF(SOXX)', 'SOXX'], ['QQQ', 'QQQ'],
  ['원/달러', 'KRW=X'], ['WTI유가', 'CL=F'], ['금', 'GC=F'],
  ['비트코인', 'BTC-USD'], ['이더리움', 'ETH-USD'],
];
const VISIONARY_ALIAS = {
  '삼전': '삼성전자', 'sk하이닉스': 'SK하이닉스', '하이닉스': 'SK하이닉스',
  'btc': '비트코인', 'eth': '이더리움', 'kospi': '코스피',
  'kosdaq': '코스닥', 'nasdaq': '나스닥', '환율': '원/달러', '달러': '원/달러',
  '유가': 'WTI유가', '반도체': '반도체ETF(SOXX)', 'soxx': '반도체ETF(SOXX)',
};
function resolveTicker(query) {
  const q = (query || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return null;
  for (const [name, ticker] of VISIONARY_WATCH) {
    if (q === name.toLowerCase().replace(/\s+/g, '') || q === ticker.toLowerCase()) return [name, ticker];
  }
  if (VISIONARY_ALIAS[q]) {
    const hit = VISIONARY_WATCH.find(([n]) => n === VISIONARY_ALIAS[q]);
    if (hit) return hit;
  }
  for (const [name, ticker] of VISIONARY_WATCH) {
    if (name.toLowerCase().replace(/\s+/g, '').includes(q)) return [name, ticker];
  }
  return null;
}

// yfinance가 감싸는 바로 그 엔드포인트를 직접 부른다(실측 확인: User-Agent만 있으면
// 별도 인증·크럼 없이 열림). Deno엔 yfinance 대응품이 없어서 직접 호출한다.
async function yfQuote(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;
    return { price: meta.regularMarketPrice };
  } catch {
    return null;
  }
}

// 순수 달력 날짜 산술(시간대 변환 없이 문자열 그대로 UTC 자정으로 파싱) -- computeTodayCamps와
// 같은 관례. 공휴일은 무시하고 주말만 건너뛴다(visionary_tool.py와 같은 한계, 정직하게 기록).
function tradingDaysAfterKST(startStr, n) {
  const d = new Date(startStr + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

const VISIONARY_HORIZON_DAYS = { short: 1, mid: 20, long: 60 };
const VISIONARY_HORIZON_LABEL = { short: '+1거래일', mid: '+1개월', long: '+3개월' };

async function fetchChannelVideos(channelId, maxN) {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) return [];
    const doc = xmlParser.parse(await r.text());
    let entries = doc?.feed?.entry || [];
    if (!Array.isArray(entries)) entries = [entries].filter(Boolean);
    return entries.slice(0, maxN).map((e) => {
      const idStr = String(e.id || '');
      const videoId = idStr.includes(':') ? idStr.split(':').pop() : idStr;
      return {
        videoId,
        title: String(e.title || ''),
        description: String(e?.['media:group']?.['media:description'] || ''),
      };
    }).filter((v) => v.videoId);
  } catch {
    return [];
  }
}

async function classifyVideo(title, description) {
  const prompt =
    '다음은 경제 유튜브 영상의 제목과 설명이야. 이 영상이 특정 시장이나 종목의 방향(오른다/내린다)을 ' +
    '명시적으로 말하고 있는지 판단해줘. 뉘앙스로만 방향이 있어도 되지만, 단순 뉴스 요약·질문·중립적 ' +
    '설명은 방향 발언이 아니야.\n\n' +
    '방향 발언이면 이 JSON만 답해: {"is_call": true, "direction": "up 또는 down", ' +
    '"target": "코스피 또는 언급된 개별 종목명", "horizon": "short(며칠 내) 또는 mid(분기·하반기) 또는 long(연 단위)", ' +
    '"statement": "발언 핵심을 짧게 그대로 인용"}\n' +
    '방향 발언이 아니면: {"is_call": false}\n\n' +
    `제목: ${title}\n설명: ${(description || '').slice(0, 500)}`;
  const answer = await callVisionaryLLM(prompt, { json: true, temperature: 0, maxTokens: 300 });
  if (!answer) return null;
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[0]);
    if (!data.is_call || (data.direction !== 'up' && data.direction !== 'down')) return null;
    return data;
  } catch {
    return null;
  }
}

/* ---- 오늘의 예측 관련 "오늘" 날짜는 전부 KST(UTC+9, DST 없음) 기준이어야 한다. 서버(Deno)는
   UTC로 돈다 -- new Date().toISOString()을 그대로 쓰면 한국 새벽 0~9시 사이엔 어제 UTC 날짜로
   찍혀서, 사용자에게는 이미 "오늘"인데 투표·댓글이 어제 날짜에 묶이는 버그가 생긴다
   (실측: UTC 20:55 = KST 05:55인데 UTC 기준으로는 여전히 전날). 9시간을 더한 뒤 UTC 날짜만
   잘라내는 방식으로 KST 달력 날짜를 얻는다. ---- */
function kstDateStr(msOffset = 0) {
  return new Date(Date.now() + msOffset + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' 두 날짜 사이의 일수 차. 발언 피드에 "N일 전" 표시할 때 씀.
function daysBetweenDateStr(fromStr, toStr) {
  const from = new Date(fromStr + 'T00:00:00Z').getTime();
  const to = new Date(toStr + 'T00:00:00Z').getTime();
  return Math.max(0, Math.round((to - from) / (24 * 60 * 60 * 1000)));
}

/* ---- 오늘의 예측: 유튜버 "최근 콜"을 오늘의 간다/빠진다 진영으로 묶을 때, 지평이 다른
   콜(예: "하반기 전망")이나 며칠 지난 낡은 콜까지 오늘 진영으로 잘못 대표시키지 않도록
   두 조건을 다 거른다 -- 짧은(+1거래일) 지평이면서 최근 3일 이내인 콜만 인정한다. ---- */
function computeTodayCamps(calls, todayStr) {
  const today = new Date(todayStr + 'T00:00:00Z');
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - 3);

  const latestByInfluencer = {};
  calls.forEach((c) => {
    if (c.horizon_label !== '+1거래일') return; // 장기 콜 제외 -- 지평 불일치 방지
    if (new Date(c.statement_date + 'T00:00:00Z') < cutoff) return; // 3일 넘은 콜 제외 -- 신선도
    const existing = latestByInfluencer[c.influencer_name];
    if (!existing || c.statement_date > existing.statement_date) latestByInfluencer[c.influencer_name] = c;
  });

  const up = [], down = [];
  Object.values(latestByInfluencer).forEach((c) => (c.direction === 'up' ? up : down).push(c.influencer_name));
  up.sort(); down.sort();
  return { up, down };
}

/* ---- 댓글 모더레이션: 욕설은 마스킹(*), 링크는 자동 숨김(hidden -- 삭제 아님, 에디터가 검토 가능).
   완벽한 우회 방지는 아님(정직하게): 자모 분리·유니코드 유사문자 치환 같은 정교한 회피까지는 못 잡음
   -- ponytail: 필요해지면 유지관리되는 공개 금칙어 데이터셋으로 교체. 지금은 흔한 표현 위주 자체 목록. ---- */
const PROFANITY_WORDS = [
  '씨발', '씨팔', '시발', '시팔', '개새끼', '개새기', '병신', '븅신', '좆', '존나', '조낸',
  '개소리', '지랄', '미친놈', '미친년', '창녀', '걸레같', '화냥년', '개년', '개자식', '등신',
  '느금', '니미', '애미', '보지', '자지', '섹스', 'ㅅㅂ', 'ㅄ', 'ㅗㅜㅑ', 'ㅁㅊ', 'ㅈㄴ',
];
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// 글자 사이에 공백·기호가 최대 2개 끼어도 잡음 (예: "씨 발", "씨.발") -- {0,2}로 상한을 둬서
// 역추적 폭발(ReDoS) 걱정 없음 (본문은 어차피 100자로 잘려 들어옴).
const PROFANITY_RE = new RegExp(
  PROFANITY_WORDS.map((w) => Array.from(w).map(escapeRegex).join('[\\s\\W]{0,2}')).join('|'),
  'gi',
);
function maskProfanity(text) {
  return text.replace(PROFANITY_RE, (m) => '*'.repeat(m.length));
}
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|co|kr|io|me|ly|gg|xyz|shop|link|click|top|info)\b)/i;
function containsLink(text) {
  return LINK_RE.test(text);
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
      // world-coverage(날짜 안 씀)에서 만든 원래 파서엔 없던 필드 -- 타임라인이 날짜를 RSS
      // 원본에서 그대로 가져오려면 필요해서 추가. RSS는 pubDate, Atom은 published/updated.
      pubDate: String(it.pubDate ?? it.published ?? it.updated ?? '').trim(),
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
/* ---- LLM 호출: Groq(무료 티어, Llama 3.3) 먼저 쓰고, 한도가 찼거나(429) 실패하면
   Cerebras(무료 티어, 같은 Llama 3.3 - Groq는 그냥 그 호스팅 업체 중 하나일 뿐이라 다른 곳에서도 돌릴 수 있음)로,
   그것도 안 되면 Gemini(무료 티어, 다른 모델)로 넘어감. 셋 다 실패하면 null - 호출부가 알아서
   "판단 못 함"일 때의 기본값(보통 fail-open)으로 처리함. ---- */
async function callOpenAiChat(url, key, model, prompt, opts) {
  if (!key) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 200,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!r.ok) return null; // 429(한도 초과) 등 - 폴백으로 넘어감
    const data = await r.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}
async function callGroq(prompt, opts) {
  return callOpenAiChat(
    'https://api.groq.com/openai/v1/chat/completions',
    Deno.env.get('GROQ_API_KEY'), 'llama-3.3-70b-versatile', prompt, opts,
  );
}
async function callCerebras(prompt, opts) {
  return callOpenAiChat(
    'https://api.cerebras.ai/v1/chat/completions',
    Deno.env.get('CEREBRAS_API_KEY'), 'llama-3.3-70b', prompt, opts,
  );
}
async function callGemini(prompt, opts) {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return null;
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: opts.temperature ?? 0,
            maxOutputTokens: opts.maxTokens ?? 200,
            ...(opts.json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
    );
    if (!r.ok) return null;
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch {
    return null;
  }
}
async function callLLM(prompt, opts = {}) {
  return (await callGroq(prompt, opts)) || (await callCerebras(prompt, opts)) || (await callGemini(prompt, opts));
}

// 비저너리(영상 분류)는 "엇갈린 시선"(세계 보도 비교)과 같은 Groq/Cerebras/Gemini
// 무료 티어를 그대로 쓰면 사용량을 나눠 써야 한다 -- 한쪽이 많이 쓰면 다른 쪽이
// fail-open으로 조용히 실패할 수 있다. OpenRouter(별도 계정·완전히 분리된 쿼터,
// callOpenAiChat이 이미 OpenAI 호환 형식이라 그대로 재사용됨)를 우선 쓰고,
// OPENROUTER_API_KEY가 없으면 기존 체인으로 그대로 폴백한다(설정 안 해도 동작 --
// deepl_api_key와 같은 패턴). 무료 모델 슬러그는 OpenRouter가 종종 바꾸니, 가입 시
// openrouter.ai/models?max_price=0 에서 현재 무료 모델명을 확인해서 필요하면 교체하세요.
async function callOpenRouter(prompt, opts) {
  return callOpenAiChat(
    'https://openrouter.ai/api/v1/chat/completions',
    Deno.env.get('OPENROUTER_API_KEY'), 'nvidia/nemotron-3-super-120b-a12b:free', prompt, opts,
  );
}
async function callVisionaryLLM(prompt, opts = {}) {
  return (await callOpenRouter(prompt, opts)) || (await callLLM(prompt, opts));
}

// 사건 타임라인도 같은 이유(다른 기능과 무료 쿼터를 나눠 쓰면 한쪽이 몰릴 때 다른 쪽이
// 조용히 fail-open됨)로 완전히 별도 계정을 쓴다. Cloudflare Workers AI는 계정당 하루
// 10,000 뉴런이 무료(유료 플랜 불필요, 매일 00:00 UTC 리셋)이고, /ai/v1/chat/completions가
// 이미 OpenAI 호환 형식이라 callOpenAiChat을 그대로 재사용한다. CLOUDFLARE_ACCOUNT_ID·
// CLOUDFLARE_API_TOKEN이 없으면 기존 체인으로 조용히 폴백(설정 안 해도 동작).
async function callCloudflare(prompt, opts) {
  const accountId = Deno.env.get('CLOUDFLARE_ACCOUNT_ID');
  const token = Deno.env.get('CLOUDFLARE_API_TOKEN');
  if (!accountId || !token) return null;
  return callOpenAiChat(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
    token, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', prompt, opts,
  );
}
async function callTimelineLLM(prompt, opts = {}) {
  return (await callCloudflare(prompt, opts)) || (await callLLM(prompt, opts));
}

async function verifySameTopic(topic, candidateTitle) {
  const prompt =
    '다음 두 제목이 같은 구체적인 사건을 다루고 있는지 확인하세요. 단어가 겹쳐도 동명이인·동음이의어 때문에 ' +
    '전혀 다른 사건일 수 있습니다 (예: 사람 이름과 회사 이름이 같은 경우).\n' +
    '기준: ' + topic + '\n비교 대상: ' + candidateTitle + '\n\n' +
    '같은 사건이면 yes, 다른 사건이면 no 라고만 답하세요.';
  const answer = await callLLM(prompt, { maxTokens: 5 });
  if (answer === null) return true; // 둘 다 응답 없음 - 키워드 매칭 결과로 fail-open
  return answer.toLowerCase().includes('yes');
}
// llmFn을 인자로 받는 이유: world-coverage(refreshCoverageForPost)는 기존 공유 체인
// (callLLM)을 그대로 쓰고, 타임라인(refreshTimelineForPost)은 완전히 분리된 callTimelineLLM을
// 쓰게 하기 위해서다 -- 안 그러면 이 함수 하나 때문에 "완전히 분리된 쿼터"라는 애초 요구사항이
// 깨진다(실측으로 확인함: 낚시성 원제목을 그대로 검색어로 쓰면 구글 뉴스가 0건을 반환한다 --
// wcExtractTopic이 실패해서 원제목으로 폴백된 게 원인이었음).
async function wcExtractTopic(title, llmFn) {
  // 제목이 "13만명이 출근을 못해...2차대전 이후 최악"처럼 낚시성/수사적 표현이면 그걸 그대로
  // 번역해서 검색해봤자 외국 매체 검색어로는 안 맞음 - 검색에 쓸 핵심 사건만 짧게 뽑아둠
  const prompt =
    '다음 기사 제목에서 낚시성 표현이나 수사적 질문은 빼고, 뉴스 검색에 바로 쓸 수 있는 핵심 사건만 ' +
    '짧은 구절(5단어 이내)로 뽑으세요. 다른 설명 없이 검색어만 답하세요.\n\n제목: ' + title;
  const answer = await (llmFn || callLLM)(prompt, { maxTokens: 30 });
  if (answer === null) return title;
  const extracted = answer.trim().replace(/^["']|["']$/g, '');
  return extracted || title;
}
// 타임라인 전용 주제 추출. wcExtractTopic은 "오늘 이 구체적인 사실을 누가 같이
// 다뤘나"를 찾는 world-coverage용이라 일부러 좁게(예: "영치금 17억") 뽑는다 -- 그
// 좁은 문구로 과거 구간을 검색하면, 정작 그 사건의 배경이 되는 더 큰 흐름(예: "윤석열
// 구속")은 몇 년째 계속 보도돼 왔어도 오늘 기사 특유의 세부 사실과 문구가 안 겹쳐서
// 전혀 안 잡힌다. 타임라인은 반대로 "이 기사가 속한 더 큰 사건"을 뽑아야 과거 보도가
// 걸린다.
async function tlExtractTopic(title, llmFn) {
  const prompt =
    '다음은 오늘 올라온 기사 제목입니다. 이 기사가 다루는 오늘자 세부 사실이 아니라, ' +
    '이 기사가 속한 더 큰 사건·이슈 자체를 뉴스 검색에 쓸 짧은 구절(5단어 이내)로 뽑으세요 ' +
    '(예: "OO 씨 구속 중 특혜 논란"이 아니라 "OO 씨 구속"). 다른 설명 없이 검색어만 답하세요.\n\n제목: ' + title;
  // temperature를 낮게 고정 -- 기본값(높음)으로 두면 같은 제목도 호출마다 "尹 구속"처럼
  // 넓게 뽑힐 때가 있고 "尹 영치금"처럼 좁게 뽑힐 때가 있어서, 실제로는 배경 보도가 널려
  // 있는 사건인데도 운 나쁘게 좁게 뽑힌 호출에서는 후보가 하나도 안 걸리는 걸 실측으로 확인함.
  const answer = await (llmFn || callLLM)(prompt, { maxTokens: 30, temperature: 0.1 });
  if (answer === null) return title;
  const extracted = answer.trim().replace(/^["']|["']$/g, '');
  return extracted || title;
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
  if (matchedResults.length < 2) return [];
  const listing = matchedResults.map((r) => `[${r.source}] ${r.item_title}`).join('\n');
  const prompt =
    '다음은 같은 사건을 다룬 여러 언론사의 기사 제목입니다.\n\n' + listing +
    '\n\n이 제목들에서 서로 다른 핵심 주장이나 초점을 3~5개 뽑고, 각각을 어느 언론사([...] 안의 이름)가 다뤘는지 표시하세요. ' +
    '반드시 다음 JSON 형식으로만 답하세요: {"claims":[{"claim":"한 문장 요약","outlets":["언론사명", ...]}]}';
  const answer = await callLLM(prompt, { json: true, temperature: 0.2, maxTokens: 800 });
  if (answer === null) return [];
  try {
    const parsed = JSON.parse(answer);
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

/* ---- 사건 타임라인: 기사가 다루는 사건이 더 큰 흐름의 일부일 때(예: "우크라이나가 이란
   선박을 공격" 앞에 "이란이 러시아에 드론을 지원했다"는 배경이 있음), 그 전후 맥락을 시간순
   으로 보여준다. world-coverage와 같은 RSS/번역/LLM 부품을 재사용하지만 목적이 다르다 --
   world-coverage는 "같은 사건을 누가 다뤘나"(같은 날짜), 타임라인은 "이 사건 이전에 뭐가
   있었나"(다른 날짜, 최대 2년 전까지). 날짜는 LLM이 절대 만들어내지 않는다 -- 전부 RSS
   pubDate 원본에서 가져오고, LLM은 후보 중 "고르기"와 "한 줄 요약"만 담당한다. ---- */
const TIMELINE_MARKETS = [
  { hl: 'ko', gl: 'KR', ceid: 'KR:ko' },
  { hl: 'en-US', gl: 'US', ceid: 'US:en' },
];
// 기사 시점을 기준으로 뒤로 갈수록 넓은 구간을 본다(최근 1개월 ~ 2년 전까지, 서로 안 겹치는
// 5개 구간) -- 한 번에 길게 검색하면 최신 기사만 잔뜩 잡히고 오래된 발단은 묻혀버려서,
// 구간을 쪼개야 오래된 사건도 골고루 후보에 오른다.
const TIMELINE_WINDOWS = [
  { fromDays: 0, toDays: 30 },
  { fromDays: 30, toDays: 90 },
  { fromDays: 90, toDays: 180 },
  { fromDays: 180, toDays: 365 },
  { fromDays: 365, toDays: 730 },
];
function tlWindowDates(anchorDateStr, fromDays, toDays) {
  const anchor = new Date(anchorDateStr + 'T00:00:00Z').getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  return {
    before: new Date(anchor - fromDays * DAY_MS).toISOString().slice(0, 10),
    after: new Date(anchor - toDays * DAY_MS).toISOString().slice(0, 10),
  };
}
async function tlFetchWindow(topic, market, after, before) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const q = topic + ' after:' + after + ' before:' + before;
    const r = await fetch(wcGoogleFeedUrl(q, market), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisualMagazineBot/1.0)' },
    });
    const text = await r.text();
    return wcParseXml(text).slice(0, 6); // 구간 하나당 후보는 최대 6개까지만
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
// 반환값(boolean)은 "이번 호출에서 실제로 새 작업을 했는지"다 -- 이미 처리된 글이면 false를
// 돌려줘서, 호출부가 예산(한 번에 몇 개 글까지)을 이미-끝난 글로 낭비하지 않게 한다.
async function refreshTimelineForPost(supabase, post) {
  const rawTitle = post.title || '';
  if (wcTokenize(rawTitle).length === 0) return false;

  // 글 하나당 딱 한 번만 시도한다 -- RSS로 배경사건이 하나도 안 나온 글도 event_count:0으로
  // 기록해서, 매번 다시 헛수고로 검색하지 않는다. 다시 시도하려면 이 행을 지우면 됨.
  const { data: existingStatus } = await supabase.from('post_timeline_status')
    .select('post_id').eq('post_id', post.id).maybeSingle();
  if (existingStatus) return false;

  const topic = await tlExtractTopic(rawTitle, callTimelineLLM);
  const anchorDate = new Date(post.created_at).toISOString().slice(0, 10);

  const perSlot = await Promise.all(
    TIMELINE_WINDOWS.flatMap((w) => {
      const { after, before } = tlWindowDates(anchorDate, w.fromDays, w.toDays);
      return TIMELINE_MARKETS.map(async (market) => {
        const items = await tlFetchWindow(topic, market, after, before);
        return items.map((item) => ({ item, market }));
      });
    }),
  );
  const found = perSlot.flat();

  // 제목 기준 중복 제거 -- 같은 사건을 여러 매체·언어권이 동시에 다뤘을 수 있음
  const seen = new Set();
  const deduped = [];
  for (const entry of found) {
    if (!entry.item.title || !entry.item.pubDate) continue;
    const key = entry.item.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  // 후보가 너무 적으면(진짜 배경사건이 없거나 검색이 안 걸림) LLM 호출 없이 "없음"으로 기록하고
  // 끝낸다 -- 억지로 타임라인을 채우는 것보다, 자신 없으면 아예 안 보여주는 게 낫다.
  if (deduped.length < 2) {
    await supabase.from('post_timeline_status').insert({ post_id: post.id, event_count: 0 });
    return true;
  }

  const candidates = deduped.slice(0, 25);
  const listing = candidates.map((c, i) =>
    '[' + i + '] ' + new Date(c.item.pubDate).toISOString().slice(0, 10) + ' - ' + c.item.title
  ).join('\n');
  const prompt =
    '다음은 "' + rawTitle + '" 기사와 관련된 과거 보도 후보 목록입니다(번호, 날짜, 제목).\n\n' + listing +
    '\n\n이 중에서 이 사건의 전후 맥락을 이해하는 데 정말 중요한 분기점만 5~8개 고르세요' +
    '(단순 후속보도·중복·무관한 기사는 빼세요). 각각을 한국어 한 문장으로 짧게 요약하세요' +
    '(날짜는 이미 있으니 요약 문장에 다시 쓰지 마세요). ' +
    '반드시 다음 JSON 형식으로만 답하세요: {"picked":[{"index":0,"summary":"..."}]}';
  const answer = await callTimelineLLM(prompt, { json: true, temperature: 0.1, maxTokens: 700 });

  let picked = [];
  if (answer) {
    try {
      const parsed = JSON.parse(answer);
      picked = Array.isArray(parsed.picked) ? parsed.picked : [];
    } catch { /* picked는 빈 배열로 남음 */ }
  }

  const rows = [];
  for (const p of picked) {
    const c = candidates[p?.index];
    if (!c) continue;
    // 실제 날짜는 항상 RSS pubDate에서 가져온다 -- LLM이 준 날짜는 절대 안 믿는다(애초에
    // 프롬프트에서 요약에 날짜를 다시 쓰지 말라고 했지만, 혹시 썼더라도 무시함).
    const eventDate = new Date(c.item.pubDate).toISOString().slice(0, 10);
    if (eventDate >= anchorDate) continue; // 기사 시점 이후는 "배경"이 아니므로 제외
    rows.push({
      post_id: post.id,
      event_date: eventDate,
      summary: String(p.summary || c.item.title).slice(0, 200),
      source: c.item.source || null,
      source_url: /^https?:\/\//i.test(c.item.link || '') ? c.item.link : null,
      is_current: false,
    });
  }

  if (rows.length > 0) {
    // 지금 읽는 기사 자신도 타임라인 마지막 마디로 넣는다 -- "내가 지금 보는 기사가 이
    // 흐름의 어디쯤인지" 보여주는 게 이 기능의 핵심이라, 배경사건이 있을 때만 같이 넣는다.
    rows.push({ post_id: post.id, event_date: anchorDate, summary: rawTitle, source: null, source_url: null, is_current: true });
    await supabase.from('post_timeline').insert(rows);
  }
  await supabase.from('post_timeline_status').insert({ post_id: post.id, event_count: rows.length });
  return true;
}

/* ---- 감정적/자극적 표현, 기자 주관이 담긴 표현 표시.
   전용 한국어 분류 모델을 따로 호스팅하는 대신, 이미 쓰고 있는 오픈소스 LLM(Llama 3.3, Groq/Gemini
   무료 티어)에게 분류를 맡김 - 문구를 원문 그대로 뽑게 해서 클라이언트가 본문에서 찾아 밑줄만 그으면 됨.
   글이 바뀌지 않는 한 다시 분석할 필요가 없어서, 이미 결과가 있으면 그냥 건너뜀(LLM 호출 아끼기). ---- */
function wcPlainText(body) {
  return (body || '')
    .replace(/<figure>[\s\S]*?<\/figure>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`]/g, '')
    .trim();
}
async function analyzeTextFlags(supabase, post) {
  const { data: existing } = await supabase.from('post_text_flags').select('id').eq('post_id', post.id).limit(1);
  if (existing && existing.length) return; // 이미 분석해둔 글은 다시 안 함

  const plain = wcPlainText(post.body).slice(0, 6000);
  if (!plain) return;
  const prompt =
    '다음은 뉴스 기사 본문입니다. 이 글에서 (1) 감정적이거나 자극적인 단어/표현과 ' +
    '(2) 객관적 사실이 아니라 기자의 주관이 담긴 표현을 찾아주세요.\n\n본문:\n' + plain +
    '\n\n규칙:\n' +
    '- phrase는 본문에 실제로 있는 문구를 토씨 하나 안 틀리고 그대로, 2~6단어 정도로 짧게 뽑으세요(문장 전체 X).\n' +
    '- reason은 왜 그런지 15자 이내로 아주 짧게 쓰세요.\n' +
    '- 확실한 것만 5~10개 정도만 뽑으세요. 억지로 채우지 마세요.\n' +
    '반드시 다음 JSON 형식으로만 답하세요: ' +
    '{"flags":[{"phrase":"본문 속 문구 그대로","type":"emotional 또는 subjective","reason":"짧은 이유"}]}';
  const answer = await callLLM(prompt, { json: true, temperature: 0.1, maxTokens: 1000 });
  if (answer === null) return;
  let parsed;
  try { parsed = JSON.parse(answer); } catch { return; }
  const flags = (Array.isArray(parsed.flags) ? parsed.flags : [])
    .filter((f) => f && typeof f.phrase === 'string' && plain.includes(f.phrase) && (f.type === 'emotional' || f.type === 'subjective'))
    .slice(0, 15)
    .map((f) => ({ post_id: post.id, phrase: f.phrase, type: f.type, reason: String(f.reason || '').slice(0, 60) }));
  if (!flags.length) return;
  await supabase.from('post_text_flags').insert(flags);
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

    // 비저너리 랭킹: 읽기 전용 공개 계산이라 VPN 판별 불필요. service_role로 읽는 이유는
    // 별도 anon 클라이언트를 새로 안 만들려는 것뿐 -- visionary_calls는 RLS가 이미 전체
    // 공개 조회를 허용해서 service_role이든 anon이든 결과는 같다(권한 상승 아님).
    if (body.action === 'visionary-ranking') {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const { data, error } = await supabaseAdmin.from('visionary_calls')
        .select('influencer_name,direction,status,price_at_call,price_at_judge,benchmark_return_pct');
      if (error) throw error;
      return new Response(JSON.stringify(computeVisionaryRanking(data || [])), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // 비저너리 발언 피드: 사람별 집계(visionary-ranking)가 아니라 발언 한 건씩 최신순.
    // 판정 전(pending)인 발언은 수익률을 아예 안 준다(null) -- 결과 없는 걸 0%나
    // 빈칸 숫자로 보여주면 "이미 나온 결과"처럼 오해하기 쉬워서, 클라이언트가
    // "판정 전"과 "수익률 0%"를 확실히 구분해서 그릴 수 있게 한다.
    if (body.action === 'visionary-feed') {
      const limit = Math.min(Number(body.limit) || 30, 100);
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const { data, error } = await supabaseAdmin.from('visionary_calls')
        .select('influencer_name,statement,direction,status,price_at_call,price_at_judge,benchmark_return_pct,statement_date,created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      const today = kstDateStr();
      const rows = (data || []).map((c) => ({
        name: c.influencer_name,
        statement: c.statement,
        direction: c.direction,
        status: c.status,
        excessReturn: c.status === 'pending' ? null : callExcessReturn(c),
        daysAgo: daysBetweenDateStr(c.statement_date, today),
      }));
      return new Response(JSON.stringify({ rows }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // visual-magazine-admin의 아이디 로그인용 이메일 조회. VPN 사용자도 정상적으로 로그인은
    // 할 수 있어야 하니 VPN 차단은 안 걸고(그건 댓글/좋아요 어뷰징용 게이트라 목적이 다름),
    // IP당 쿨다운만 건다 -- 이거 없이 anon에게 RPC를 직접 열어두면 아이디를 무작위로 시도해서
    // 회원 이메일을 긁어모으는 열거 공격이 가능했다(email-lookup-lockdown-migration.sql 참고).
    if (body.action === 'lookup-email') {
      const ip = detectIp(req);
      const username = String(body.username || '').trim().slice(0, 40);
      if (!username) throw new Error('아이디가 필요해요.');
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const LOOKUP_RATE_LIMIT_SECONDS = 3;
      const { data: rl } = await supabaseAdmin.from('email_lookup_rate_limit').select('last_at').eq('ip', ip).maybeSingle();
      if (rl && Date.now() - new Date(rl.last_at).getTime() < LOOKUP_RATE_LIMIT_SECONDS * 1000) {
        return new Response(JSON.stringify({ error: '너무 빠르게 연속 시도했어요. 잠시 후 다시 시도해주세요.' }), {
          status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await supabaseAdmin.from('email_lookup_rate_limit').upsert({ ip, last_at: new Date().toISOString() });

      const { data: email, error } = await supabaseAdmin.rpc('get_email_by_username', { uname: username });
      if (error) throw error;
      return new Response(JSON.stringify({ email: email || null }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // 오늘의 예측 현황: 읽기 전용이라 VPN 판별 불필요. 투표/댓글 작성은 아래(VPN 통과 후)에서 처리.
    if (body.action === 'today-status') {
      const ip = detectIp(req);
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const today = kstDateStr();
      const recentCutoff = kstDateStr(-5 * 24 * 60 * 60 * 1000);
      const [votesRes, myVoteRes, callsRes] = await Promise.all([
        supabaseAdmin.from('daily_votes').select('direction').eq('vote_date', today),
        supabaseAdmin.from('daily_votes').select('direction').eq('vote_date', today).eq('ip', ip).maybeSingle(),
        supabaseAdmin.from('visionary_calls').select('influencer_name,direction,horizon_label,statement_date')
          .gte('statement_date', recentCutoff),
      ]);
      const votes = votesRes.data || [];
      const camps = computeTodayCamps(callsRes.data || [], today);
      return new Response(JSON.stringify({
        voteDate: today,
        upVotes: votes.filter((v) => v.direction === 'up').length,
        downVotes: votes.filter((v) => v.direction === 'down').length,
        myVote: myVoteRes.data ? myVoteRes.data.direction : null,
        campUp: camps.up, campDown: camps.down,
      }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // 스케줄러(cron)가 주기적으로 호출 - 방문자 요청이 아니라 VPN/국가 판별은 필요 없음.
    // [보안 강화] 이 분기는 원래 인증 없이 열려 있었다 -- action 이름만 알면(코드가 공개
    // 저장소에 있으니 누구나 안다) anon 키만으로 아무나 호출할 수 있었고, 호출될 때마다
    // 전체 글을 순회하며 외부 RSS·LLM(Groq/Cerebras/Gemini) 호출을 대량으로 일으킨다 --
    // 무료 API 한도 소진·DoS성 남용에 그대로 노출돼 있었다. CRON_SECRET 환경변수를 설정하고
    // 호출부(스케줄러)가 같은 값을 x-cron-secret 헤더로 보내야만 통과하게 막는다.
    // 엇갈린 시선 + 타임라인을 미리 다 채운 뒤에만 글을 공개한다(관리자 패널 저장 버튼이
    // posts INSERT 직후 이 액션을 기다렸다가 응답을 받으면 화면을 넘어감). CRON_SECRET이
    // 아니라 호출자의 로그인 세션(JWT)으로 직접 권한을 확인한다 -- 이건 크론이 아니라
    // 에디터가 글을 쓸 때 브라우저에서 직접 부르는 액션이라 크론 비밀키를 알 필요가 없다.
    if (body.action === 'prepare-post') {
      const anonClient = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_ANON_KEY'),
        { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } },
      );
      const { data: isEditor } = await anonClient.rpc('is_approved_editor');
      if (!isEditor) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const { data: post } = await supabaseAdmin.from('posts').select('id,title,created_at')
        .eq('id', body.post_id).maybeSingle();
      if (!post) {
        return new Response(JSON.stringify({ error: 'post not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      // 둘 중 하나가 실패해도(네트워크 오류 등) 글이 영영 안 뜨면 안 되니, 각각 실패를
      // 삼키고 그냥 넘어간다 -- 두 함수 다 "찾을 게 없으면 없다고 기록"까지가 정상 종료라,
      // 진짜 예외만 여기서 막는다.
      await Promise.all([
        refreshCoverageForPost(supabaseAdmin, post).catch(() => {}),
        refreshTimelineForPost(supabaseAdmin, post).catch(() => {}),
      ]);
      await supabaseAdmin.from('posts').update({ published: true }).eq('id', post.id);

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'refresh-coverage') {
      const cronSecret = Deno.env.get('CRON_SECRET');
      if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const { data: posts, error: postsError } = await supabaseAdmin.from('posts').select('id,title,created_at');
      if (postsError) throw postsError;
      const DAY_MS = 24 * 60 * 60 * 1000;
      // 타임라인은 world-coverage와 달리 글 나이 상관없이 언젠가 한 번만 처리하면 되지만,
      // 밀린 글이 많을 때 한 번의 호출에서 전부 다 시도하면 RSS 검색(구간x언어 조합)이
      // 쌓여서 150초 유휴 타임아웃에 걸릴 수 있다(비저너리에서 실측했던 것과 같은 문제) --
      // 한 번에 최대 3개 글까지만 새로 처리하고, 나머지는 다음 호출 때 이어서 처리한다.
      let timelineBudget = 3;
      for (const post of posts || []) {
        // 게시 24시간 지난 글은 그 시점 이후로 새로 다룬 언론사가 더 나올 가능성이 낮아서 검색을 그만둠
        // (LLM 호출도 아끼고, 오래된 글까지 매번 다시 검색하느라 갱신 주기가 늘어지는 것도 방지)
        const ageMs = Date.now() - new Date(post.created_at).getTime();
        if (ageMs <= DAY_MS) await refreshCoverageForPost(supabaseAdmin, post);
        await analyzeTextFlags(supabaseAdmin, post).catch(() => {});
        if (timelineBudget > 0 && await refreshTimelineForPost(supabaseAdmin, post).catch(() => false)) timelineBudget--;
      }
      return new Response(JSON.stringify({ ok: true, refreshed: (posts || []).length }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // 글이 올라오는 순간 바로 타임라인을 만든다 -- 관리자 패널이든 AI 에디터든, 어떤 경로로
    // posts에 INSERT되든 상관없이 잡아내야 해서 클라이언트(관리자 패널) 쪽에 훅을 심는 대신
    // Supabase Database Webhook(테이블: posts, 이벤트: Insert)이 이 액션을 직접 호출하게
    // 한다. 웹훅 기본 payload 모양 그대로({type,table,record,...}) 받고, 수동 테스트용으로
    // {action:'timeline-single', post_id}도 같이 받아준다. refresh-coverage의 정기 스윕과
    // 중복 실행돼도 post_timeline_status가 이미 처리된 글은 즉시 걸러내므로 무해하다.
    if ((body.type === 'INSERT' && body.table === 'posts' && body.record) || body.action === 'timeline-single') {
      const cronSecret = Deno.env.get('CRON_SECRET');
      if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      let post = body.record || null;
      if (!post && body.post_id) {
        const { data } = await supabaseAdmin.from('posts').select('id,title,created_at').eq('id', body.post_id).maybeSingle();
        post = data;
      }
      if (post) await refreshTimelineForPost(supabaseAdmin, post).catch(() => {});
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // 비저너리 수집: refresh-coverage와 같은 이유로 CRON_SECRET 필수(공개 anon 키만으로
    // 아무나 호출하면 LLM·Yahoo Finance 호출을 무제한 트리거하고, 실존 인물 이름에 잘못된
    // 발언 기록을 남길 위험도 있다).
    if (body.action === 'visionary-collect') {
      const cronSecret = Deno.env.get('CRON_SECRET');
      if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const benchmark = await yfQuote('^KS11');
      if (!benchmark) {
        return new Response(JSON.stringify({ error: '벤치마크 시세 조회 실패' }), {
          status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const statementDate = kstDateStr();
      // 채널 19개를 순서대로(for await) 돌리면 채널당 몇 초씩만 걸려도 합이 150초
      // 유휴 타임아웃을 넘긴다(실측: 504 IDLE_TIMEOUT). 채널 간에는 서로 의존관계가
      // 없으니 Promise.all로 동시에 돌려서 총 시간을 "가장 느린 채널 하나" 수준으로
      // 줄인다 -- 채널 안의 영상 2~3개는 그대로 순서대로(LLM 요청 폭주 방지).
      const results = await Promise.all(VISIONARY_CHANNELS.map(async (ch) => {
        let channelChecked = 0, channelInserted = 0;
        const videos = await fetchChannelVideos(ch.channelId, 3);
        for (const v of videos) {
          channelChecked++;
          const cls = await classifyVideo(v.title, v.description);
          if (!cls) continue;

          const resolved = resolveTicker(cls.target) || ['코스피', '^KS11'];
          const [targetLabel, ticker] = resolved;
          const q = await yfQuote(ticker);
          if (!q) continue;

          const horizon = VISIONARY_HORIZON_DAYS[cls.horizon] ? cls.horizon : 'short';
          const judgeDate = tradingDaysAfterKST(statementDate, VISIONARY_HORIZON_DAYS[horizon]);
          const row = {
            influencer_name: ch.name,
            statement: (cls.statement || v.title).slice(0, 500),
            statement_date: statementDate,
            direction: cls.direction,
            target_label: targetLabel,
            ticker,
            benchmark_ticker: '^KS11',
            horizon_label: VISIONARY_HORIZON_LABEL[horizon],
            judge_date: judgeDate,
            price_at_call: q.price,
            benchmark_price_at_call: benchmark.price,
            status: 'pending',
            source_url: `https://www.youtube.com/watch?v=${v.videoId}`,
            video_id: v.videoId,
          };
          // video_id unique 제약 위반(23505)이면 이미 처리된 영상이라는 뜻 -- 정상, 그냥 건너뜀.
          const { error } = await supabaseAdmin.from('visionary_calls').insert(row);
          if (!error) channelInserted++;
        }
        return { checked: channelChecked, inserted: channelInserted };
      }));
      const checked = results.reduce((sum, r) => sum + r.checked, 0);
      const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
      return new Response(JSON.stringify({ ok: true, checked, inserted }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'visionary-judge') {
      const cronSecret = Deno.env.get('CRON_SECRET');
      if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const today = kstDateStr();
      const { data: rows, error: rowsError } = await supabaseAdmin.from('visionary_calls').select('*')
        .eq('status', 'pending').lte('judge_date', today);
      if (rowsError) throw rowsError;

      // 판정 대상이 많아지면(19개 채널로 늘어난 뒤) 순서대로 돌리다 150초 유휴
      // 타임아웃을 넘길 수 있다(visionary-collect와 같은 문제) -- 벤치마크는 미리
      // 한 번에 받아 캐시해두고(중복 조회 방지), 행별 판정은 Promise.all로 동시에.
      const uniqueBenchmarks = [...new Set((rows || []).map((r) => r.benchmark_ticker || '^KS11'))];
      const benchmarkEntries = await Promise.all(uniqueBenchmarks.map(async (bt) => [bt, await yfQuote(bt)]));
      const benchmarkCache = Object.fromEntries(benchmarkEntries);

      const results = await Promise.all((rows || []).map(async (row) => {
        const q = await yfQuote(row.ticker);
        if (!q || row.price_at_call == null) return false;
        const bt = row.benchmark_ticker || '^KS11';
        const bq = benchmarkCache[bt];
        if (!bq || row.benchmark_price_at_call == null) return false;

        const assetReturn = (q.price - row.price_at_call) / row.price_at_call * 100;
        const hit = row.direction === 'up' ? assetReturn > 0 : assetReturn < 0;
        const benchmarkReturn = (bq.price - row.benchmark_price_at_call) / row.benchmark_price_at_call * 100;
        const { error: updErr } = await supabaseAdmin.from('visionary_calls').update({
          price_at_judge: q.price,
          benchmark_price_at_judge: bq.price,
          benchmark_return_pct: benchmarkReturn,
          status: hit ? 'hit' : 'miss',
          judged_at: new Date().toISOString(),
        }).eq('id', row.id);
        return !updErr;
      }));
      const judged = results.filter(Boolean).length;
      return new Response(JSON.stringify({ ok: true, judged }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // 비저너리 발언 정리: 발언 나온 지 7일 지나면 지운다. 단, 판정이 아직 안 나왔으면
    // (주말이 껴서 장이 안 열려 판정을 못 했을 수 있음) 지우지 않고 판정될 때까지
    // 기다렸다가, 판정된 다음 날 지운다 -- 판정도 못 받고 그냥 사라지는 걸 막기 위함.
    if (body.action === 'visionary-cleanup') {
      const cronSecret = Deno.env.get('CRON_SECRET');
      if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL'),
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      );
      const cutoffStatementDate = kstDateStr(-7 * 24 * 60 * 60 * 1000);
      const cutoffJudgedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabaseAdmin.from('visionary_calls')
        .delete()
        .lte('statement_date', cutoffStatementDate)
        .neq('status', 'pending')
        .lte('judged_at', cutoffJudgedAt)
        .select('id');
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true, deleted: (data || []).length }), {
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

      // [보안 강화] increment_likes RPC 직접 호출은 막아뒀지만(increment-likes-lockdown-migration.sql),
      // 이 엔드포인트 자체에는 쿨다운이 없어서 스크립트로 연타하면 여전히 무제한으로 쌓을 수 있었다.
      // comment의 15초 제한과 같은 방식, 다만 좋아요는 부담이 적어 더 짧게 둔다.
      const LIKE_RATE_LIMIT_SECONDS = 3;
      const { data: rl } = await supabase.from('like_rate_limit').select('last_at').eq('ip', ip).maybeSingle();
      if (rl && Date.now() - new Date(rl.last_at).getTime() < LIKE_RATE_LIMIT_SECONDS * 1000) {
        return new Response(JSON.stringify({ error: '너무 빠르게 연속 요청했어요. 잠시 후 다시 시도해주세요.' }), {
          status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await supabase.from('like_rate_limit').upsert({ ip, last_at: new Date().toISOString() });

      const { error } = await supabase.rpc('increment_likes', { post_id: postId });
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'comment') {
      const postId = Number(body.post_id);
      const nickname = maskProfanity(String(body.nickname || '').trim().slice(0, 20));
      const avatarSeed = String(body.avatar_seed || '').trim().slice(0, 40);
      const rawText = String(body.body || '').trim().slice(0, 100);
      const text = maskProfanity(rawText);
      const hidden = containsLink(rawText);
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
        ip_prefix: prefix, country, hidden, hidden_reason: hidden ? 'link' : null,
      }).select().single();
      if (error) throw error;
      // 숨김 처리된 댓글은 작성자 본인 화면에도 그대로 보여주면 "링크 넣으면 숨겨지는구나"를
      // 광고/스팸 계정이 바로 알아채고 회피법을 학습하게 됨 -- 응답에서 hidden 여부만 안내하고
      // data 자체는 그대로 돌려줘서(내 댓글 목록에 내가 쓴 건 보이게), 실제 화면 노출은
      // loadComments()가 hidden=false만 쿼리하므로 자동으로 걸러짐.
      return new Response(JSON.stringify({ data, hidden }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'today-vote') {
      const direction = body.direction === 'up' || body.direction === 'down' ? body.direction : null;
      if (!direction) throw new Error('direction이 필요해요.');
      const today = kstDateStr();
      const { error } = await supabase.from('daily_votes').insert({ vote_date: today, ip, direction });
      if (error) {
        if (error.code === '23505') { // unique_violation: (vote_date, ip) 중복 -- 하루 1표
          return new Response(JSON.stringify({ error: '오늘은 이미 투표했어요.' }), {
            status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        throw error;
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'today-comment') {
      const nickname = maskProfanity(String(body.nickname || '').trim().slice(0, 20));
      const avatarSeed = String(body.avatar_seed || '').trim().slice(0, 40);
      const rawText = String(body.body || '').trim().slice(0, 100);
      const text = maskProfanity(rawText);
      const hidden = containsLink(rawText);
      if (!nickname || !text) throw new Error('입력값이 비어있어요.');

      // comment_rate_limit을 글 댓글과 공유한다 -- 같은 IP당 15초 제한이라는 목적이 동일해서
      // 테이블을 따로 안 둔다(오늘의 예측 댓글을 올리면 잠깐 글 댓글도 못 쓰게 되지만, 부담이
      // 적은 트레이드오프로 판단).
      const RATE_LIMIT_SECONDS = 15;
      const { data: rl } = await supabase.from('comment_rate_limit').select('last_at').eq('ip', ip).maybeSingle();
      if (rl && Date.now() - new Date(rl.last_at).getTime() < RATE_LIMIT_SECONDS * 1000) {
        return new Response(JSON.stringify({ error: '너무 빠르게 연속 작성했어요. 잠시 후 다시 시도해주세요.' }), {
          status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await supabase.from('comment_rate_limit').upsert({ ip, last_at: new Date().toISOString() });

      const today = kstDateStr();
      const { data: existingRows } = await supabase.from('today_comments').select('nickname').eq('vote_date', today);
      const existingNames = new Set((existingRows || []).map((r) => r.nickname));
      let finalNickname = nickname;
      if (existingNames.has(finalNickname)) {
        let n = 2;
        while (existingNames.has(nickname + n)) n++;
        finalNickname = nickname + n;
      }

      const { data, error } = await supabase.from('today_comments').insert({
        vote_date: today, nickname: finalNickname, avatar_seed: avatarSeed, body: text,
        ip_prefix: prefix, country, hidden, hidden_reason: hidden ? 'link' : null,
      }).select().single();
      if (error) throw error;
      return new Response(JSON.stringify({ data, hidden }), {
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
