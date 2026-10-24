-- 2026-10-25: a payment opens one account, ever. Idempotent; safe to re-run.
--
-- api/v7/account/signup.js accepted any paid checkout with business_id NULL as
-- unclaimed. But business_id is ON DELETE SET NULL, so deleting a business
-- (the 2026-10-24 purge of every account did) made its payment claimable
-- again: anyone holding the checkout id could sign up without paying.
-- claimed_at records the first link to a business and survives the business's
-- deletion; signup refuses a checkout that has it but no business.

alter table public.payment_checkouts add column if not exists claimed_at timestamptz;

-- Stamped by the database the first time a checkout is linked to a business:
-- a signup's claim, and a renewal (linked when it's created). The app never
-- has to remember to set it.
create or replace function public.payment_checkouts_stamp_claim()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.business_id is not null and new.claimed_at is null then
    new.claimed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists payment_checkouts_stamp_claim on public.payment_checkouts;
create trigger payment_checkouts_stamp_claim
  before insert or update of business_id on public.payment_checkouts
  for each row execute function public.payment_checkouts_stamp_claim();

-- Backfill: every checkout linked to a business now, plus orders 4, 7 and 9,
-- whose businesses were deleted on 2026-10-24.
update public.payment_checkouts
   set claimed_at = coalesce(updated_at, paid_at, created_at, now())
 where claimed_at is null
   and (business_id is not null or order_no in (4, 7, 9));

-- Check: expect reusable_paid_checkouts = 0 (a paid checkout not linked to a
-- business and never claimed is one a signup could still use).
select
  count(*) filter (where status = 'paid' and business_id is null and claimed_at is null) as reusable_paid_checkouts,
  count(*) filter (where claimed_at is not null)                                         as claimed,
  count(*) filter (where status = 'paid')                                                as paid
from public.payment_checkouts;
