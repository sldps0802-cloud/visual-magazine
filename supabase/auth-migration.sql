-- 로그인 기능 추가: 글에 작성자(user_id) 연결, 본인 글만 수정/삭제 가능하게

alter table posts add column user_id uuid references auth.users(id);
alter table posts add column author_email text;

drop policy if exists "anyone can insert posts" on posts;

-- 로그인한 사용자만 글 작성 가능, 자기 user_id로만 작성 가능
create policy "authenticated users can insert their own posts"
  on posts for insert
  with check (auth.uid() = user_id);

-- 본인 글만 수정 가능
create policy "users can update their own posts"
  on posts for update
  using (auth.uid() = user_id);

-- 본인 글만 삭제 가능
create policy "users can delete their own posts"
  on posts for delete
  using (auth.uid() = user_id);
