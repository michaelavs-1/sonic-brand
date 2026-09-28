-- Migration: billing details on v7 payment checkouts.
--
-- Why: the payment screen now collects the cardholder name + optional
-- address, business name (the invoice is made out to it when filled) and tax
-- ID (ח.פ / ע.מ), and sends them to Hyp with the payment page. Keeping a copy
-- on the checkout row records what each invoice was issued to.
--
-- billing = { name, address, invoiceBusinessName, taxId } (empty strings
-- for fields left blank).
--
-- Idempotent. Run in Supabase SQL Editor (after 2026-09-27-v7-payments.sql).

ALTER TABLE payment_checkouts ADD COLUMN IF NOT EXISTS billing jsonb;
