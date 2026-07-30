-- '비저너리' 섹션: 경제 유튜버/인플루언서의 시장 발언을 발언 원문·시점·판정 결과로 기록.
-- 판정은 부호(적중/빗나감)뿐 아니라 같은 기간 코스피 대비 초과수익(alpha)도 함께 남겨서
-- "그냥 강세장이라 맞았다"를 걸러낼 수 있게 한다. 데이터 입력은 관리자만 (Supabase 대시보드에서 직접 등록).
create table visionary_calls (
  id bigint generated always as identity primary key,
  influencer_name text not null,
  statement text not null,
  statement_date date not null,
  direction text not null check (direction in ('up','down')),
  target_label text not null default 'KOSPI',
  ticker text not null default '^KS11',
  benchmark_ticker text not null default '^KS11',
  horizon_label text not null default '+1거래일',
  judge_date date,
  price_at_call numeric,
  price_at_judge numeric,
  benchmark_price_at_call numeric,
  benchmark_price_at_judge numeric,
  benchmark_return_pct numeric,
  status text not null default 'pending' check (status in ('pending','hit','miss')),
  source_url text,
  video_id text unique,
  created_at timestamptz not null default now()
);

alter table visionary_calls enable row level security;

create policy "visionary calls are viewable by everyone"
  on visionary_calls for select
  using (true);

-- 아래 insert/update/delete 정책은 브라우저에서 로그인한 관리자용(수동 수정용)이다.
-- vcompany7/visionary_tool.py 자동 수집·판정 배치는 이 정책을 거치지 않고
-- service_role 키로 직접 쓴다(RLS 우회, 서버에서만 보관 -- fortune_site 공개 JS에 절대 넣지 않는다).
-- 'YOUR-EMAIL' 부분을 실제 관리자 로그인 이메일로 바꿔서 Supabase SQL Editor에서 실행하세요.
create policy "only admin can insert visionary calls"
  on visionary_calls for insert
  with check (auth.email() = 'YOUR-EMAIL');

create policy "only admin can update visionary calls"
  on visionary_calls for update
  using (auth.email() = 'YOUR-EMAIL');

create policy "only admin can delete visionary calls"
  on visionary_calls for delete
  using (auth.email() = 'YOUR-EMAIL');
