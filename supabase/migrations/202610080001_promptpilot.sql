-- Run once in the new PromptPilot project's SQL Editor. No credentials here.
begin;
create table if not exists public.pp_members (
  email text primary key check(email = lower(email)),
  role text not null check(role in ('admin','member')),
  enabled boolean not null default true
);
create table if not exists public.pp_entities (
  id text primary key,
  kind text not null check(kind in ('project','version','case','model','run','result','review')),
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists pp_entities_kind on public.pp_entities(kind);
create index if not exists pp_entities_project on public.pp_entities((data->>'project_id'));
create unique index if not exists pp_version_number on public.pp_entities((data->>'project_id'),(data->>'number')) where kind='version';
create table if not exists public.pp_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id text not null references public.pp_entities(id),
  job jsonb not null,
  state text not null default 'pending' check(state in ('pending','running','done')),
  started_at timestamptz,
  created_at timestamptz not null default now(),
  result jsonb
);
create index if not exists pp_jobs_pending on public.pp_jobs(state,created_at);
create table if not exists public.pp_quota (
  day date not null,
  bucket text not null,
  used integer not null default 0,
  primary key(day,bucket)
);

alter table public.pp_members enable row level security;
alter table public.pp_entities enable row level security;
alter table public.pp_jobs enable row level security;
alter table public.pp_quota enable row level security;
-- No direct client access, including logged-in clients. The Edge Function is
-- the sole application API and checks identity + membership before DB access.
revoke all on public.pp_members,public.pp_entities,public.pp_jobs,public.pp_quota from public,anon,authenticated;
grant all on public.pp_members,public.pp_entities,public.pp_jobs,public.pp_quota to service_role;

-- Add approved users separately in the dashboard; do not publish their emails.

create or replace function public.pp_reserve(p_bucket text,p_amount integer,p_limit integer)
returns void language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  if p_amount<1 or p_limit<1 then raise exception 'Invalid quota'; end if;
  insert into pp_quota(day,bucket,used) values ((now() at time zone 'UTC')::date,p_bucket,p_amount)
  on conflict(day,bucket) do update set used=pp_quota.used+excluded.used
  returning used into n;
  if n>p_limit then raise exception '今日调用额度已达到上限，请明日再试'; end if;
end $$;

create or replace function public.pp_create_run(p_run jsonb,p_jobs jsonb,p_limit integer)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(81237645);
  if exists(select 1 from pp_entities where kind='run' and data->>'status'='running') then
    raise exception '已有评测正在运行；打开报告页面继续执行';
  end if;
  if jsonb_array_length(p_jobs)<1 or jsonb_array_length(p_jobs)>200 then raise exception '无效调用数量'; end if;
  perform pp_reserve('model_calls',jsonb_array_length(p_jobs),p_limit);
  insert into pp_entities(id,kind,data) values(p_run->>'id','run',p_run);
  insert into pp_jobs(run_id,job) select p_run->>'id',value from jsonb_array_elements(p_jobs);
end $$;

create or replace function public.pp_sync_runs()
returns void language plpgsql security definer set search_path=public as $$
begin
  update pp_entities r set data=r.data || jsonb_build_object(
    'completed',s.done,'status',case when s.done=s.total then 'completed' else 'running' end)
    || case when s.done=s.total then jsonb_build_object('finished_at',now()) else '{}'::jsonb end
  from (select run_id,count(*) total,count(*) filter(where state='done') done from pp_jobs group by run_id) s
  where r.kind='run' and r.id=s.run_id and r.data->>'status'='running';
end $$;

create or replace function public.pp_claim_job()
returns setof public.pp_jobs language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(81237646);
  -- Interrupted/expired calls are NOT retried automatically (avoid double billing).
  update pp_jobs set state='done',result=jsonb_build_object(
    'id',id,'run_id',run_id,'case_id',job->'case'->>'id',
    'version_id',job->'version'->>'id','model_id',job->'model'->>'id',
    'status','error','error','云端执行中断或超过租约，未自动重试；需要时请另建评测',
    'raw',null,'parsed',null,'checks','[]'::jsonb,'rendered_prompt',null,
    'elapsed_ms',120000,'created_at',now())
  where state='running' and started_at<now()-interval '2 minutes';
  perform pp_sync_runs();
  if exists(select 1 from pp_jobs where state='running') then return; end if;
  return query update pp_jobs set state='running',started_at=now()
    where id=(select id from pp_jobs where state='pending' order by created_at,id limit 1 for update skip locked)
    returning *;
end $$;

create or replace function public.pp_finish_job(p_id uuid,p_result jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(81237646);
  update pp_jobs set state='done',result=p_result where id=p_id and state='running';
  perform pp_sync_runs();
end $$;

revoke all on function public.pp_reserve(text,integer,integer),public.pp_create_run(jsonb,jsonb,integer),public.pp_sync_runs(),public.pp_claim_job(),public.pp_finish_job(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pp_reserve(text,integer,integer),public.pp_create_run(jsonb,jsonb,integer),public.pp_sync_runs(),public.pp_claim_job(),public.pp_finish_job(uuid,jsonb) to service_role;
commit;
