-- 기사 본문에서 감정적/자극적 표현(emotional)과 기자 주관이 담긴 표현(subjective)을
-- 미리 분석해두는 캐시. refresh-coverage Edge Function이 글마다 한 번만 채워두고,
-- post.html은 그냥 읽어서 본문 텍스트 위에 표시만 함.
create table post_text_flags (
  id bigint generated always as identity primary key,
  post_id bigint not null references posts(id) on delete cascade,
  phrase text not null,
  type text not null check (type in ('emotional', 'subjective')),
  reason text,
  created_at timestamptz not null default now()
);
alter table post_text_flags enable row level security;

-- 누구나 읽기는 가능, 쓰기는 service_role(Edge Function)만
create policy "text flags viewable by everyone" on post_text_flags for select using (true);
