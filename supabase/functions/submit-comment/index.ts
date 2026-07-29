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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const body = await req.json();
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
